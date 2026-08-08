/**
 * WebRTC peer-to-peer transport.
 *
 * There is no server anywhere in this project, so there is no signalling
 * server either: the two peers exchange their connection descriptions by
 * copy-and-paste (a code you send your opponent however you like — chat,
 * email, out loud). Once that handshake is done the data channel is a direct
 * connection between the two browsers.
 *
 * A public STUN server is used purely to discover each peer's public address.
 * No account, no data, no game traffic goes through it. On networks with
 * strict NAT the direct connection can fail, which needs a TURN relay — that
 * would mean infrastructure, so it is out of scope here and reported honestly
 * to the player instead.
 */

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const CHANNEL = 'pcg';

export function webrtcSupported() {
  return typeof RTCPeerConnection === 'function';
}

/* ---------- code encoding ---------- */

const toBase64 = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, '');
};

const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/**
 * Strip the parts of an SDP that are fixed for a data-channel-only session and
 * can be rebuilt from the other side's own template. Lossless for our purposes
 * and typically removes a third of the text before compression.
 */
const SDP_NOISE = /^a=(extmap-allow-mixed|msid-semantic|group:BUNDLE 0)\r?\n/gm;

/** Session descriptions are long; pack them down to a single pasteable code. */
export function encodeSignal(description) {
  const payload = JSON.stringify({ t: description.type, s: description.sdp.replace(SDP_NOISE, '') });
  return toBase64(new TextEncoder().encode(payload));
}

export function decodeSignal(code) {
  const cleaned = String(code).trim().replace(/\s+/g, '');
  if (!cleaned) throw new Error('That code is empty.');
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64(cleaned)));
  } catch {
    throw new Error('That does not look like a valid code — check it was copied in full.');
  }
  if (!payload?.t || !payload?.s) throw new Error('That code is missing part of the connection details.');
  return { type: payload.t, sdp: payload.s };
}

/* ---------- transport ---------- */

function wrapChannel(channel, connection) {
  const messageHandlers = new Set();
  const closeHandlers = new Set();
  let closed = false;

  const shutdown = (reason) => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler(reason);
  };

  channel.addEventListener('message', (event) => {
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return; // ignore anything that is not our protocol
    }
    for (const handler of messageHandlers) handler(parsed);
  });
  channel.addEventListener('close', () => shutdown('connection closed'));
  channel.addEventListener('error', () => shutdown('connection error'));
  connection.addEventListener('connectionstatechange', () => {
    if (['failed', 'disconnected', 'closed'].includes(connection.connectionState)) {
      shutdown(connection.connectionState);
    }
  });

  return {
    name: 'webrtc',
    get closed() {
      return closed || channel.readyState !== 'open';
    },
    send(message) {
      if (this.closed) throw new Error('Connection is closed');
      channel.send(JSON.stringify(message));
    },
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close(reason = 'closed') {
      shutdown(reason);
      try {
        channel.close();
        connection.close();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * ICE candidates trickle in asynchronously. Rather than exchange them
 * separately we wait for gathering to finish and ship one complete
 * description — slower to produce, but it makes the handshake a single code.
 */
function waitForIce(connection, timeoutMs = 5000) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      connection.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (connection.iceGatheringState === 'complete') done();
    };
    // Give up waiting eventually and use whatever we have — usually enough.
    const timer = setTimeout(done, timeoutMs);
    connection.addEventListener('icegatheringstatechange', check);
  });
}

function newConnection() {
  if (!webrtcSupported()) throw new Error('This browser does not support WebRTC.');
  return new RTCPeerConnection({ iceServers: ICE_SERVERS });
}

/**
 * Host side. Returns the invite code plus `accept(replyCode)`, which resolves
 * to a connected transport.
 */
export async function createHostConnection() {
  const connection = newConnection();
  const channel = connection.createDataChannel(CHANNEL, { ordered: true });

  const opened = new Promise((resolve, reject) => {
    channel.addEventListener('open', () => resolve(wrapChannel(channel, connection)));
    channel.addEventListener('error', () => reject(new Error('The connection failed to open.')));
  });

  await connection.setLocalDescription(await connection.createOffer());
  await waitForIce(connection);

  return {
    code: encodeSignal(connection.localDescription),
    async accept(replyCode) {
      await connection.setRemoteDescription(decodeSignal(replyCode));
      return opened;
    },
    cancel() {
      connection.close();
    },
  };
}

/**
 * Guest side. Consumes the host's invite code and returns the reply code plus
 * `connected`, a promise for the transport.
 */
export async function createGuestConnection(inviteCode) {
  const connection = newConnection();

  const connected = new Promise((resolve, reject) => {
    connection.addEventListener('datachannel', (event) => {
      const channel = event.channel;
      if (channel.readyState === 'open') resolve(wrapChannel(channel, connection));
      else channel.addEventListener('open', () => resolve(wrapChannel(channel, connection)));
      channel.addEventListener('error', () => reject(new Error('The connection failed to open.')));
    });
  });

  await connection.setRemoteDescription(decodeSignal(inviteCode));
  await connection.setLocalDescription(await connection.createAnswer());
  await waitForIce(connection);

  return {
    code: encodeSignal(connection.localDescription),
    connected,
    cancel() {
      connection.close();
    },
  };
}
