// main.js - AirShare P2P file sharing logic

let peer = null;
let currentDataConnection = null;
let localPeerId = null;
let incomingTransfers = new Map();

// DOM elements
const peerStatusDot = document.getElementById('peerStatusDot');
const peerStatusText = document.getElementById('peerStatusText');
const localPeerIdSpan = document.getElementById('localPeerIdDisplay');
const remotePeerIdInput = document.getElementById('remotePeerIdInput');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const connectionStatusMsg = document.getElementById('connectionStatusMsg');
const fileInput = document.getElementById('fileInput');
const transferQueueDiv = document.getElementById('transferQueue');
const transferCounterSpan = document.getElementById('transferCounter');
const sendWarningDiv = document.getElementById('sendWarning');
const copyPeerBtn = document.getElementById('copyPeerBtn');
const themeToggle = document.getElementById('themeToggleBtn');

// Helper: update transfer counter
function updateTransferCounter() {
  const items = document.querySelectorAll('.transfer-item');
  transferCounterSpan.innerText = items.length;
  if (items.length === 0 && transferQueueDiv.innerHTML.includes('Ready to share')) return;
  if (items.length === 0 && !transferQueueDiv.innerHTML.includes('Ready to share')) {
    transferQueueDiv.innerHTML = `<div class="text-center text-slate-400 text-sm py-6 italic">Ready to share. Connect to a peer → select files → auto-send</div>`;
  }
}

function escapeHtml(str) {
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}

function addTransferItem(fileName, fileSizeBytes, type, direction, fileBlobUrl = null, mimeType = '') {
  const itemId = 'item_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const sizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);
  const directionIcon = direction === 'out' ? '📤' : '📥';
  const directionText = direction === 'out' ? 'Sent' : 'Received';
  const bgClass = direction === 'out' ? 'bg-indigo-50 dark:bg-indigo-900/20' : 'bg-emerald-50 dark:bg-emerald-900/20';

  let previewHtml = '';
  if (fileBlobUrl && mimeType) {
    if (mimeType.startsWith('image/')) {
      previewHtml = `<img src="${fileBlobUrl}" class="file-preview-img object-cover" alt="preview">`;
    } else if (mimeType.startsWith('video/')) {
      previewHtml = `<video class="file-preview-img object-cover" muted><source src="${fileBlobUrl}" type="${mimeType}"></video>`;
    } else {
      previewHtml = `<div class="file-preview-img flex items-center justify-center bg-slate-200 dark:bg-slate-700 text-lg">📄</div>`;
    }
  } else {
    previewHtml = `<div class="file-preview-img flex items-center justify-center bg-slate-100 dark:bg-slate-700 text-lg">${directionIcon}</div>`;
  }

  const progressHtml = direction === 'out' ? 
    `<div class="flex items-center gap-2 mt-1"><div class="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden"><div class="progress-bar h-full bg-indigo-500 rounded-full" style="width: 0%"></div></div><span class="text-[11px] text-slate-500 progress-percent">0%</span></div>` :
    `<div class="flex items-center gap-2 mt-1"><div class="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden"><div class="progress-bar h-full bg-emerald-500 rounded-full" style="width: 0%"></div></div><span class="text-[11px] text-slate-500 progress-percent">0%</span></div>`;

  const downloadHtml = (fileBlobUrl && direction === 'in') ? `<a href="${fileBlobUrl}" download="${fileName}" class="text-xs bg-white dark:bg-slate-700 rounded-full px-2 py-1 shadow-sm border border-slate-200 dark:border-slate-600 hover:bg-slate-50">⬇️ Save</a>` : '';

  const itemHtml = `
    <div class="transfer-item ${bgClass} rounded-xl p-2 flex items-start gap-3 border border-slate-200 dark:border-slate-700" data-id="${itemId}">
      ${previewHtml}
      <div class="flex-1 min-w-0">
        <div class="flex justify-between items-start flex-wrap gap-1">
          <span class="font-medium text-sm truncate max-w-[150px] sm:max-w-[250px]">${escapeHtml(fileName)}</span>
          <span class="text-[11px] text-slate-400">${sizeMB} MB</span>
        </div>
        <div class="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5">
          <span>${directionText}</span> 
          <span class="opacity-50">•</span> 
          <span class="transfer-status-text">${type === 'complete' ? '✅ Complete' : '⏳ Transferring...'}</span>
        </div>
        ${progressHtml}
        <div class="flex justify-end mt-1">${downloadHtml}</div>
      </div>
    </div>
  `;

  if (transferQueueDiv.innerHTML.includes('Ready to share')) {
    transferQueueDiv.innerHTML = '';
  }
  transferQueueDiv.insertAdjacentHTML('afterbegin', itemHtml);
  updateTransferCounter();
  return itemId;
}

function updateProgressForItem(itemId, percent, isOutgoing = true) {
  const itemDiv = document.querySelector(`.transfer-item[data-id="${itemId}"]`);
  if (itemDiv) {
    const progressFill = itemDiv.querySelector('.progress-bar');
    const percentSpan = itemDiv.querySelector('.progress-percent');
    if (progressFill) progressFill.style.width = `${percent}%`;
    if (percentSpan) percentSpan.innerText = `${percent}%`;
    if (percent >= 100) {
      const statusSpan = itemDiv.querySelector('.transfer-status-text');
      if (statusSpan) statusSpan.innerText = '✅ Complete';
    }
  }
}

// Chunked sending
const CHUNK_SIZE = 32000;

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binaryStr = atob(base64);
  const len = binaryStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes.buffer;
}

async function sendFileViaConnection(file, connection) {
  if (!connection || connection.open === false) {
    alert('Not connected to any peer. Please connect first.');
    return false;
  }
  const fileId = `${Date.now()}_${file.name}_${file.size}`;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const itemId = addTransferItem(file.name, file.size, 'inprogress', 'out', null, file.type);

  const metadata = {
    type: 'fileStart',
    fileId: fileId,
    name: file.name,
    size: file.size,
    mime: file.type,
    totalChunks: totalChunks
  };
  connection.send(JSON.stringify(metadata));

  let offset = 0;
  let chunkIndex = 0;
  const reader = new FileReader();

  const readSlice = (start) => {
    const slice = file.slice(start, start + CHUNK_SIZE);
    reader.onload = (e) => {
      const arrayBuffer = e.target.result;
      const base64Chunk = arrayBufferToBase64(arrayBuffer);
      const chunkMsg = {
        type: 'fileChunk',
        fileId: fileId,
        chunk: base64Chunk,
        index: chunkIndex,
        total: totalChunks
      };
      connection.send(JSON.stringify(chunkMsg));
      offset += CHUNK_SIZE;
      chunkIndex++;
      const percent = Math.min(100, Math.floor((offset / file.size) * 100));
      updateProgressForItem(itemId, percent, true);

      if (offset < file.size) {
        readSlice(offset);
      } else {
        connection.send(JSON.stringify({ type: 'fileEnd', fileId: fileId }));
        updateProgressForItem(itemId, 100, true);
      }
    };
    reader.onerror = () => {
      console.error('file read error');
      connection.send(JSON.stringify({ type: 'fileError', fileId: fileId }));
    };
    reader.readAsArrayBuffer(slice);
  };
  readSlice(0);
  return true;
}

function handleDataMessage(ev, connection) {
  const raw = ev.data;
  if (typeof raw === 'string') {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'fileStart') {
        if (incomingTransfers.has(msg.fileId)) return;
        const newItemId = addTransferItem(msg.name, msg.size, 'inprogress', 'in', null, msg.mime);
        incomingTransfers.set(msg.fileId, {
          bufferChunks: [],
          receivedBytes: 0,
          totalSize: msg.size,
          fileName: msg.name,
          fileType: msg.mime,
          totalChunks: msg.totalChunks || 0,
          uiItemId: newItemId,
          chunksReceived: 0
        });
      }
      else if (msg.type === 'fileChunk') {
        const transfer = incomingTransfers.get(msg.fileId);
        if (transfer) {
          const chunkBuffer = base64ToArrayBuffer(msg.chunk);
          transfer.bufferChunks.push(chunkBuffer);
          transfer.receivedBytes += chunkBuffer.byteLength;
          transfer.chunksReceived = (transfer.chunksReceived || 0) + 1;
          const percent = Math.min(100, Math.floor((transfer.receivedBytes / transfer.totalSize) * 100));
          if (transfer.uiItemId) updateProgressForItem(transfer.uiItemId, percent, false);
        }
      }
      else if (msg.type === 'fileEnd') {
        const transfer = incomingTransfers.get(msg.fileId);
        if (transfer) {
          const combined = new Uint8Array(transfer.receivedBytes);
          let position = 0;
          for (const chunkBuf of transfer.bufferChunks) {
            const chunkArr = new Uint8Array(chunkBuf);
            combined.set(chunkArr, position);
            position += chunkArr.byteLength;
          }
          const blob = new Blob([combined], { type: transfer.fileType || 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const existingItem = document.querySelector(`.transfer-item[data-id="${transfer.uiItemId}"]`);
          if (existingItem) {
            const downloadDiv = existingItem.querySelector('.flex.justify-end.mt-1');
            if (downloadDiv) {
              downloadDiv.innerHTML = `<a href="${url}" download="${transfer.fileName}" class="text-xs bg-white dark:bg-slate-700 rounded-full px-2 py-1 shadow-sm border border-slate-200 dark:border-slate-600 hover:bg-slate-50">⬇️ Save</a>`;
            }
            const statusSpan = existingItem.querySelector('.transfer-status-text');
            if (statusSpan) statusSpan.innerText = '✅ Complete';
            updateProgressForItem(transfer.uiItemId, 100, false);
          } else {
            addTransferItem(transfer.fileName, transfer.totalSize, 'complete', 'in', url, transfer.fileType);
          }
          incomingTransfers.delete(msg.fileId);
        }
      }
    } catch(e) { console.warn("non-json message", raw); }
  }
}

function setupDataConnection(conn) {
  if (currentDataConnection) {
    try { currentDataConnection.close(); } catch(e) {}
  }
  currentDataConnection = conn;
  currentDataConnection.on('open', () => {
    connectionStatusMsg.innerHTML = `🔗 Connected to: ${conn.peer.substring(0, 10)}... • now you can send files`;
    peerStatusText.innerText = `Connected • ${conn.peer.substring(0, 8)}`;
    sendWarningDiv.classList.add('hidden');
  });
  currentDataConnection.on('data', (data) => handleDataMessage({ data }, conn));
  currentDataConnection.on('close', () => {
    connectionStatusMsg.innerHTML = `❌ Connection closed`;
    peerStatusText.innerText = "Online • idle";
    currentDataConnection = null;
  });
  currentDataConnection.on('error', (err) => {
    console.warn("data channel error", err);
    connectionStatusMsg.innerHTML = `Connection error: ${err.message}`;
  });
}

function initPeer() {
  if (peer) {
    try { peer.destroy(); } catch(e) {}
  }
  peer = new Peer({
    debug: 0,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] }
  });

  peer.on('open', (id) => {
    localPeerId = id;
    localPeerIdSpan.innerText = id;
    peerStatusDot.className = "h-2.5 w-2.5 rounded-full bg-emerald-500";
    peerStatusText.innerText = "Online • ready to share";
    connectionStatusMsg.innerText = `Your ID: ${id.substring(0, 8)}... | Share this to connect`;
  });

  peer.on('connection', (conn) => {
    if (currentDataConnection && currentDataConnection.open) {
      currentDataConnection.close();
    }
    setupDataConnection(conn);
    connectionStatusMsg.innerText = `✅ Incoming connection from ${conn.peer.substring(0, 8)}...`;
  });

  peer.on('error', (err) => {
    console.error(err);
    peerStatusDot.className = "h-2.5 w-2.5 rounded-full bg-red-500";
    peerStatusText.innerText = "Connection error (signaling)";
    connectionStatusMsg.innerText = "⚠️ PeerJS error: retry or check network";
    if (err.type === 'unavailable-id') {
      setTimeout(() => initPeer(), 1500);
    }
  });

  peer.on('disconnected', () => {
    peerStatusDot.className = "h-2.5 w-2.5 rounded-full bg-amber-500";
    peerStatusText.innerText = "Disconnected • reconnect needed";
    connectionStatusMsg.innerText = "Peer disconnected. Reload page to reinitialize.";
  });
}

function connectToRemote(remoteId) {
  if (!peer) {
    alert("Peer not ready, please wait.");
    return;
  }
  if (currentDataConnection && currentDataConnection.open) {
    currentDataConnection.close();
  }
  const conn = peer.connect(remoteId, { reliable: true });
  setupDataConnection(conn);
  connectionStatusMsg.innerHTML = `⏳ Connecting to ${remoteId.substring(0, 8)}...`;
}

function disconnectFromPeer() {
  if (currentDataConnection) {
    currentDataConnection.close();
    currentDataConnection = null;
    connectionStatusMsg.innerHTML = "Disconnected manually";
    peerStatusText.innerText = "Online • idle";
  } else {
    connectionStatusMsg.innerHTML = "No active connection";
  }
}

// Event listeners
connectBtn.onclick = () => {
  const remoteId = remotePeerIdInput.value.trim();
  if (!remoteId) {
    alert("Please enter remote Peer ID");
    return;
  }
  if (remoteId === localPeerId) {
    alert("You cannot connect to yourself");
    return;
  }
  connectToRemote(remoteId);
};

disconnectBtn.onclick = () => {
  disconnectFromPeer();
};

copyPeerBtn.onclick = () => {
  if (localPeerId) {
    navigator.clipboard.writeText(localPeerId);
    copyPeerBtn.innerText = 'Copied!';
    setTimeout(() => copyPeerBtn.innerText = 'Copy', 1500);
  } else {
    alert("Peer ID not ready yet");
  }
};

fileInput.onchange = async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  if (!currentDataConnection || currentDataConnection.open !== true) {
    sendWarningDiv.classList.remove('hidden');
    sendWarningDiv.innerText = "⚠️ Not connected to any peer. Establish connection first.";
    setTimeout(() => sendWarningDiv.classList.add('hidden'), 2500);
    fileInput.value = '';
    return;
  }
  sendWarningDiv.classList.add('hidden');
  for (const file of files) {
    if (file.size > 100 * 1024 * 1024) {
      alert(`File ${file.name} exceeds 100MB. Skipped.`);
      continue;
    }
    await sendFileViaConnection(file, currentDataConnection);
    await new Promise(r => setTimeout(r, 120));
  }
  fileInput.value = '';
};

// Dark mode
let isDark = localStorage.getItem('airshare-theme') === 'dark';
if (isDark) document.documentElement.classList.add('dark');
themeToggle.onclick = () => {
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('airshare-theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
};

// Start
initPeer();