const encoders = new Map();

async function videoRequest(message) {
  const { id } = message;
  if (message.operation === 'probe') {
    if (typeof VideoEncoder === 'undefined') return { supported: false };
    return { supported: (await VideoEncoder.isConfigSupported({ codec: 'vp8', width: 1920, height: 1080, bitrate: 2000000, framerate: 15, latencyMode: 'realtime' })).supported };
  }
  if (message.operation === 'close') {
    const state = encoders.get(id);
    if (state) state.cancelled = true;
    if (state?.encoder && state.encoder.state !== 'closed') state.encoder.close();
    encoders.delete(id);
    return {};
  }
  let state = encoders.get(id);
  if (state?.lastImage === message.data && !message.keyFrame) return { unchanged: true };
  if (!state) { state = { encoder: null, cancelled: false }; encoders.set(id, state); }
  const bytes = Uint8Array.from(atob(message.data), c => c.charCodeAt(0));
  let bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  try {
    const scale = Math.min(1, 1920 / bitmap.width, 1080 / bitmap.height);
    if (scale < 1) {
      const resized = await createImageBitmap(bitmap, { resizeWidth: Math.max(1, Math.floor(bitmap.width * scale)), resizeHeight: Math.max(1, Math.floor(bitmap.height * scale)) });
      bitmap.close(); bitmap = resized;
    }
    if (state.cancelled) throw new Error('Encoding cancelled');
    if (state.width !== bitmap.width || state.height !== bitmap.height) {
      if (state.encoder && state.encoder.state !== 'closed') state.encoder.close();
      Object.assign(state, { width: bitmap.width, height: bitmap.height, count: 0, chunks: [], error: null });
      const current = state;
      state.encoder = new VideoEncoder({
        output(chunk) {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          let binary = '';
          for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
          current.chunks.push({ data: btoa(binary), type: chunk.type, timestamp: chunk.timestamp });
        },
        error(error) { current.error = error; },
      });
      state.encoder.configure({ codec: 'vp8', width: bitmap.width, height: bitmap.height, bitrate: 2000000, framerate: 15, latencyMode: 'realtime' });
      encoders.set(id, state);
    }
    if (state.error) throw state.error;
    const frame = new VideoFrame(bitmap, { timestamp: state.count * 66667 });
    try { state.encoder.encode(frame, { keyFrame: !!message.keyFrame || state.count % 60 === 0 }); }
    finally { frame.close(); }
    await state.encoder.flush();
    if (state.error) throw state.error;
    if (state.chunks.length !== 1) throw new Error('Unexpected encoded frame count');
    state.count++;
    state.lastImage = message.data;
    return { ...state.chunks.shift(), codec: 'vp8', width: bitmap.width, height: bitmap.height };
  } finally { bitmap.close(); }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'video') return;
  videoRequest(message).then(respond, error => respond({ error: String(error) }));
  return true;
});
