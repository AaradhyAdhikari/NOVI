// The phone's side of the laptop-screen video (plugins/live-screen/stream.js sends it). Novi's socket carries
// the offer and this answer; the video itself goes straight over Tailscale, so no outside servers.
export async function answerOffer(sdp, { Peer = globalThis.RTCPeerConnection, onTrack, onState, waitMs = 3000 } = {}) {
  const pc = new Peer({ iceServers: [] });
  pc.ontrack = (e) => onTrack?.(e);
  pc.onconnectionstatechange = () => onState?.(pc.connectionState);
  await pc.setRemoteDescription({ type: 'offer', sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  // One message each way: the answer waits for its addresses (at most waitMs).
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(resolve, waitMs);
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } };
  });
  return { pc, sdp: pc.localDescription.sdp };
}
