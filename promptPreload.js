const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // --- Renderer to Main (ipcRenderer.send for one-way) ---
 
  // Send the selected prompt (predefined or custom) to the main process
  sendPromptSelection: (promptData) => {
    // promptData should be an object like { type: 'predefined'/'custom', value: 'prompt text', inputText: '...' }
    ipcRenderer.send('prompt-selected', promptData);
  },
 
  // Tell the main process to copy the provided text and close the window
  copyAndClose: (textToCopy) => {
    ipcRenderer.send('copy-and-close', textToCopy);
  },
 
  // Tell the main process to close the window (e.g., from 'X' button)
  closeWindow: () => {
    ipcRenderer.send('close-prompt-window');
  },
 
  // --- Renderer to Main (ipcRenderer.invoke for two-way/async) ---
 
  // Get current configuration from main process
  getConfig: () => ipcRenderer.invoke('get-config'),
 
  // Send new configuration to main process to save
  setConfig: (newConfig) => ipcRenderer.invoke('set-config', newConfig),

  // --- Main to Renderer ---

  // Set up listener for receiving clipboard content from the main process
  // The callback function provided by the renderer will be executed
  onClipboardContent: (callback) => {
    // Receive the content and pass it to the renderer's callback
    ipcRenderer.on('clipboard-content', (event, content) => {
      callback(content); // content should be { type: 'text'/'image', data: '...' }
    });
  },

  // Set up listener for receiving LLM response chunks/completion from the main process
  onLLMResponse: (callback) => {
    // Receive the chunk/text and pass it to the renderer's callback
    ipcRenderer.on('llm-response', (event, responseChunk) => {
      callback(responseChunk); // Can be text chunks or a special end marker like '__LLM_STREAM_END__'
    });
  }
});

console.log('[Preload] promptPreload.js loaded and contextBridge exposed.');
// Note: Checking window.electronAPI here might still show undefined due to context isolation timing.
// The real check is in the renderer script itself.