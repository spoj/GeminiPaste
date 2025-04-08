import { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs'; // Added for file system access
import mime from 'mime-types'; // Added for MIME type checking
import axios from 'axios';
import Store from 'electron-store'; // Import directly
import { fileURLToPath } from 'url'; // Needed for __dirname equivalent

// ESM equivalent for __dirname and __filename
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let store = null; // Will be initialized in whenReady
let tray = null;
let mainWindow = null;
// Store initialization will be moved to app.whenReady()

// let settingsWindow = null; // Removed - Settings now in prompt window

// Main window creation (currently unused, kept for potential future use)
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // mainWindow.loadFile('index.html');

    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'icon.png');
    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
        // { label: 'Show App', click: () => mainWindow?.show() },
        // { label: 'Settings', click: createSettingsWindow }, // Removed - Settings now in prompt window
        { type: 'separator' },
        { label: 'Exit', click: () => {
            app.isQuitting = true;
            app.quit();
        }}
    ]);

    tray.setToolTip('Gemini Paste Helper');
    tray.setContextMenu(contextMenu);
}

function registerShortcut() {
    const modifier = store.get('hotkeyModifier', 'Shift');
    const key = store.get('hotkeyKey', 'V');
    const shortcut = `CommandOrControl+${modifier}+${key}`;

    try {
        if (globalShortcut.isRegistered(shortcut)) {
            console.warn(`Shortcut ${shortcut} already registered. Unregistering first.`);
            globalShortcut.unregister(shortcut);
        }

        const ret = globalShortcut.register(shortcut, () => {
            console.log(`${shortcut} pressed!`);
            handleHotkey();
        });

        if (!ret) {
            console.error('Failed to register global shortcut:', shortcut);
        } else {
            console.log('Global shortcut registered successfully:', shortcut);
        }
    } catch (error) {
        console.error('Error registering shortcut:', error);
    }
}

let promptWindow = null;
let capturedContent = null;

function handleHotkey() {
    try {
        capturedContent = null; // Reset captured content initially
        const formats = clipboard.availableFormats();
        // console.log('Clipboard formats:', formats); // Keep this commented out unless debugging

        let filePath = null;

        // Check for file paths (often text/uri-list or plain text starting with file://)
        if (formats.includes('text/uri-list')) {
            const uriListRaw = clipboard.read('text/uri-list');
            // console.log(`Raw content of 'text/uri-list': [${uriListRaw}] (Length: ${uriListRaw?.length})`); // Keep commented out
            // uri-list can contain multiple files, often newline-separated. Take the first one. Clean up potential null chars.
            const lines = uriListRaw.replace(/\0/g, '').split(/[\r\n]+/).filter(line => line.trim() !== '' && !line.startsWith('#'));
            if (lines.length > 0 && lines[0].startsWith('file://')) {
                try {
                     // Decode URI and remove 'file://' prefix. Handle platform differences.
                     const decodedPath = decodeURI(lines[0]);
                     filePath = process.platform === 'win32'
                         ? decodedPath.substring('file:///'.length) // Windows: file:///C:/...
                         : decodedPath.substring('file://'.length);  // macOS/Linux: file:///path... or file://localhost/path...
                     console.log('Found file path in uri-list:', filePath);
                } catch (e) {
                     console.error('Error decoding URI:', lines[0], e);
                     filePath = null; // Reset if decoding fails
                }
            }
        }

        // Fallback: Check plain text if it looks like a file path
        if (!filePath && formats.includes('text/plain')) {
            const text = clipboard.readText();
            if (text.startsWith('file://')) {
                 try {
                     const decodedPath = decodeURI(text);
                     filePath = process.platform === 'win32'
                         ? decodedPath.substring('file:///'.length)
                         : decodedPath.substring('file://'.length);
                     console.log('Found file path in plain text:', filePath);
                 } catch (e) {
                     console.error('Error decoding URI from text:', text, e);
                     filePath = null;
                 }
            } else {
                 const trimmedText = text.trim(); // Trim whitespace
                 if (fs.existsSync(trimmedText)) { // Check if trimmed plain text IS a valid path directly
                     filePath = trimmedText;
                     console.log('Found potential file path in plain text (direct, trimmed):', filePath);
                 }
            }
        }


        // --- Process File Path if Found ---
        if (filePath && fs.existsSync(filePath)) {
            try {
                const stats = fs.statSync(filePath);
                if (stats.isFile()) {
                    const fileSize = stats.size;
                    const mimeType = mime.lookup(filePath) || 'application/octet-stream'; // Get MIME type
                    console.log(`File detected: ${filePath}, Size: ${fileSize}, MIME: ${mimeType}`);

                    // Check for supported image types
                    if (mimeType.startsWith('image/')) {
                        const fileBuffer = fs.readFileSync(filePath);
                        const base64 = fileBuffer.toString('base64');
                        const dataUrl = `data:${mimeType};base64,${base64}`;
                        capturedContent = { type: 'image', data: dataUrl };
                        console.log('Captured file as image.');
                    }
                    // Check for supported text types (e.g., text/plain) and size limit
                    else if (mimeType.startsWith('text/') && fileSize < 100 * 1024) { // 100KB limit
                        const textContent = fs.readFileSync(filePath, 'utf8');
                        capturedContent = { type: 'text', data: textContent };
                        console.log('Captured file as text.');
                    } else {
                        console.log(`File type (${mimeType}) or size (${fileSize}) not supported for direct input.`);
                        // Optionally: Provide feedback to the user?
                    }
                } else {
                     console.log(`Path exists but is not a file: ${filePath}`);
                }
            } catch (err) {
                console.error(`Error processing file path ${filePath}:`, err);
                capturedContent = null; // Ensure it's null on error
            }
        }

        // --- Fallback to Standard Clipboard Read if No Supported File Found ---
        if (!capturedContent) {
            console.log('No supported file captured, checking standard clipboard content...');
            const clipboardText = clipboard.readText();
            const clipboardImage = clipboard.readImage(); // Read image only if text isn't primary

            if (clipboardText && !filePath) { // Prioritize text unless a file path was specifically copied
                capturedContent = { type: 'text', data: clipboardText };
                 console.log('Captured standard clipboard text.');
            } else if (!clipboardImage.isEmpty()) {
                console.log('Captured standard clipboard image.');
                const imageBase64 = clipboardImage.toDataURL();
                capturedContent = { type: 'image', data: imageBase64 };
            } else {
                console.log('Clipboard is empty or has unsupported content (after file check).');
                // capturedContent remains null
            }
        }

        // --- Show Window or Send Content ---
        if (!capturedContent) {
             console.log('No capturable content found.');
             return; // Exit if nothing was captured
        }

        if (promptWindow && !promptWindow.isDestroyed()) {
            console.log('Prompt window exists. Sending new content and focusing.');
            promptWindow.webContents.send('clipboard-content', capturedContent);
            if (promptWindow.isMinimized()) promptWindow.restore();
            promptWindow.focus();
        } else {
            console.log('Prompt window does not exist or was destroyed. Creating new one...');
            createPromptWindow();
        }

    } catch (error) {
        console.error('Error during hotkey handling:', error);
        capturedContent = null;
    }
}

function createPromptWindow() {
    // Ensure promptWindow is null if the previous window instance was destroyed
    if (promptWindow) { // Changed from 'else if' to 'if'
        console.log('Prompt window variable existed but window was destroyed, nullifying variable.');
        promptWindow = null;
    }

    promptWindow = new BrowserWindow({
        width: 450,
        height: 600,
        frame: false,
        resizable: true,
        alwaysOnTop: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'promptPreload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });

    promptWindow.loadFile(path.join(__dirname, 'prompt.html'));

    // Optional: Close prompt if it loses focus (currently disabled)
    // promptWindow.on('blur', () => { promptWindow?.close(); });

    promptWindow.once('ready-to-show', () => {
        console.log('Prompt window ready-to-show event fired.');
        if (promptWindow && !promptWindow.isDestroyed() && capturedContent) {
             console.log('Sending clipboard-content to renderer:', { type: capturedContent.type, dataLength: capturedContent.data?.length });
             promptWindow.webContents.send('clipboard-content', capturedContent);
        } else {
             console.warn('Prompt window ready but no captured content or window destroyed.');
        }
         console.log('Showing prompt window.');
         promptWindow.show();
    });

    promptWindow.on('closed', () => {
        console.log('Prompt window closed.');
        promptWindow = null;
    });
    // Close window on Escape key press
    promptWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') {
            console.log('Escape key pressed, closing prompt window.');
            promptWindow?.close(); // Use optional chaining in case it's already closing
        }
    });
}

ipcMain.on('prompt-selected', async (event, promptData) => {
    // promptData contains { type, value, inputText }
    console.log(`IPC 'prompt-selected' received:`, { type: promptData.type, value: promptData.value, inputTextLength: promptData.inputText?.length });

    if (!promptWindow || promptWindow.isDestroyed()) {
        console.error('Prompt window does not exist or is destroyed.');
        capturedContent = null;
        return;
    }

    // Check if we have text input from renderer OR captured image content from main process
    if (!promptData.inputText && capturedContent?.type !== 'image') {
        console.error('No input text provided and no captured image available.');
        if (promptWindow && !promptWindow.isDestroyed()) {
            promptWindow.webContents.send('llm-response', 'Error: No input text or image available to process.');
            promptWindow.webContents.send('llm-response', '__LLM_STREAM_END__');
        }
        capturedContent = null;
        return;
    }

    // API Key check
    const apiKey = store.get('apiKey');
    if (!apiKey) {
        console.error('API Key not configured.');
        // Optionally, open settings window automatically?
        // createSettingsWindow();
        promptWindow.webContents.send('llm-response', 'Error: API Key not configured. Please set it in Settings.');
        promptWindow.webContents.send('llm-response', '__LLM_STREAM_END__');
        capturedContent = null;
        return;
    }

    const currentPromptWindow = promptWindow; // Reference window in case it gets closed during async API call

    try {
        console.log('Calling OpenRouter API with prompt:', promptData.value);
        const responseData = await callApi(promptData.inputText, capturedContent?.type === 'image' ? capturedContent : null, promptData.value);
        console.log('OpenRouter API Response received (truncated):', JSON.stringify(responseData).substring(0, 200) + '...');

        // Extract text response (assuming OpenAI-compatible structure)
        let textResponse = "Error: Could not parse API response."; // Default error
        try {
            if (responseData?.choices?.[0]?.message?.content) {
                textResponse = responseData.choices[0].message.content;
                console.log('Extracted text response from OpenRouter (truncated):', textResponse.substring(0, 100) + '...');
            } else {
                 console.warn("Could not find text in standard OpenRouter/OpenAI response structure. Response:", JSON.stringify(responseData));
                 textResponse = JSON.stringify(responseData); // Fallback to stringifying the whole response
            }
        } catch (parseError) {
             console.error("Error parsing OpenRouter response:", parseError, "Original response:", responseData);
             textResponse = "Error: Failed to parse API response.";
        }

        if (currentPromptWindow && !currentPromptWindow.isDestroyed()) {
            if (textResponse) {
                console.log('Sending API response chunk to renderer (truncated):', textResponse.substring(0, 100) + '...');
                currentPromptWindow.webContents.send('llm-response', textResponse);
            } else {
                 console.error('No text content found in API response.');
                 currentPromptWindow.webContents.send('llm-response', 'Error: Received empty response from API.');
            }
        }

    } catch (error) {
        console.error('Error calling API or processing response:', error);
         if (currentPromptWindow && !currentPromptWindow.isDestroyed()) {
            currentPromptWindow.webContents.send('llm-response', `Error: API call failed. ${error.message || ''}`);
         }
    } finally {
        // Send end marker to renderer
        if (currentPromptWindow && !currentPromptWindow.isDestroyed()) {
            console.log('Sending __LLM_STREAM_END__ to renderer.');
            currentPromptWindow.webContents.send('llm-response', '__LLM_STREAM_END__');
        }
        // capturedContent is cleared elsewhere (on window close or new hotkey)
    }
});

ipcMain.on('copy-and-close', (event, textToCopy) => {
    console.log(`IPC 'copy-and-close' received. Text length: ${textToCopy?.length}`);
    if (textToCopy) {
        clipboard.writeText(textToCopy);
        console.log('Copied text to clipboard.');
    }
    if (promptWindow && !promptWindow.isDestroyed()) {
        console.log('Closing prompt window after copy.');
        promptWindow.close();
    }
});

ipcMain.on('close-prompt-window', () => {
    console.log(`IPC 'close-prompt-window' received.`);
    if (promptWindow && !promptWindow.isDestroyed()) {
        console.log('Closing prompt window via close button.');
        promptWindow.close();
    }
});

async function callApi(inputText, imageContent, userPrompt) {
    const apiKey = store.get('apiKey');
    if (!apiKey) {
        console.error('API Key is missing in callApi.');
        // Optionally, open settings window automatically?
        // createSettingsWindow();
        throw new Error("API Key is missing. Please configure it in Settings.");
    }

    const model = store.get('model');
    const url = 'https://openrouter.ai/api/v1/chat/completions';

    console.log(`Calling OpenRouter API (${model}) with prompt: "${userPrompt}"`);

    // Construct messages array (OpenAI format)
    let messages = [];

    // --- Message 1: Input Content (Text or Image) ---
    let inputMessageContent = [];
    let contentProvided = false;

    // Add clipboard text (if provided)
    if (inputText) {
        inputMessageContent.push({ type: "text", text: inputText });
        console.log('Preparing text content for API, length:', inputText.length);
        contentProvided = true;
    }

    // Add clipboard image (if provided)
    if (imageContent?.type === 'image') {
        // Assumes imageContent.data is a base64 data URL
        inputMessageContent.push({
            type: "image_url",
            image_url: {
                url: imageContent.data
            }
        });
        console.log('Preparing image content for API, mime-type inferred from data URL.');
        contentProvided = true;
    }

    // Ensure some content (text or image) was added for the first message
    if (!contentProvided) {
         console.error('No text or image content provided for API call.');
         throw new Error("No text or image content provided for API call.");
    }
    messages.push({ role: "user", content: inputMessageContent });


    // --- Message 2: User Prompt ---
    if (userPrompt) { // Ensure prompt isn't empty
        messages.push({ role: "user", content: userPrompt });
        console.log('Adding user prompt as second message:', userPrompt);
    } else {
        console.warn('User prompt is empty, sending only input content.');
        // Decide if an empty prompt is an error or acceptable. Currently acceptable.
    }

    const requestBody = {
        model: model,
        messages: messages,
        provider: { order: store.get('providerOrder') }
        // Optional parameters:
        // temperature: 0.7,
        // max_tokens: 1024,
    };

    // Log request structure (excluding sensitive data like API key or full image data)
    console.log('Sending OpenRouter API request body structure:', JSON.stringify({
        model: model,
        messages: messages.map(msg => ({
            role: msg.role,
            content: Array.isArray(msg.content)
                ? msg.content.map(part => part.type === 'text' ? { type: 'text', length: part.text?.length } : { type: 'image_url' }) // Safe length check
                : typeof msg.content === 'string' ? { type: 'text', length: msg.content.length } : 'unknown'
        }))
    }));


    try {
        console.log('Executing axios.post to OpenRouter API...');
        const response = await axios.post(url, requestBody, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'YOUR_SITE_URL', // Replace with your actual site URL if applicable
                'X-Title': 'Gemini Paste Helper' // Optional: Helps OpenRouter identify your app
            },
            timeout: 60000
        });

        console.log('OpenRouter API Response Status:', response.status);
        return response.data;
    } catch (error) {
        if (error.response) {
            // Server responded with a non-2xx status code
            console.error('API Error Response Data:', error.response.data);
            console.error('API Error Response Status:', error.response.status);
            console.error('API Error Response Headers:', error.response.headers);
        } else if (error.request) {
            // Request was made, but no response received
            console.error('API Error Request (No Response):', error.request);
        } else {
            // Other error during request setup
            console.error('API Error Message:', error.message);
        }
        console.error('API Config used:', { Key: store.get('apiKey') ? 'Exists' : 'Missing' });
        throw error;
    }
}


// --- App Lifecycle ---

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    console.log('Another instance detected, quitting this one.');
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        console.log('Second instance detected, focusing existing window.');
        // Focus the main window if it exists (currently unused)
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    // App initialization
    app.whenReady().then(() => { // No longer need async here
        console.log('App ready event.');
        // Initialize electron-store here
        console.log('Initializing electron-store...');
        store = new Store({ // Use the Store imported at the top
            defaults: {
                apiKey: '',
                hotkeyModifier: 'Shift',
                hotkeyKey: 'V',
                presetPrompts: [ // Changed to array of objects
                    { name: 'Summarize', prompt: 'Summarize' },
                    { name: 'To Table', prompt: 'Convert to a tab-separated table' },
                    { name: 'Explain', prompt: 'Explain' }
                ],
                model: 'google/gemini-2.0-flash-001',
                providerOrder: ['Google']
            }
        });
        console.log('electron-store initialized successfully.');

        console.log('Creating tray...');
        createTray();
        // createWindow(); // Main window creation is disabled
        console.log('Registering shortcut...');
        registerShortcut();
        app.on('activate', () => { // macOS dock support
            console.log('App activate event (macOS).');
            // Show main window if it exists (currently unused)
             if (mainWindow) mainWindow.show();
        });
    });

    // window-all-closed is not relevant for a tray-only app
    app.on('window-all-closed', () => {
        console.log('Window-all-closed event (should not typically occur).');
        // Tray app should not quit when windows (like the prompt) are closed.
        // if (process.platform !== 'darwin') app.quit();
    });

    // Cleanup before quitting
    app.on('will-quit', () => {
        console.log('App will-quit event.');
        globalShortcut.unregisterAll();
        console.log('Shortcuts unregistered. Quitting.');
    });
}

// --- Settings Window (Removed - Integrated into prompt window) ---

// --- IPC Handlers for Settings ---

ipcMain.handle('get-config', (event) => {
    // Ensure store is initialized before accessing
    if (!store) return { error: 'Store not ready' };
    return {
        apiKey: store.get('apiKey'),
        hotkeyModifier: store.get('hotkeyModifier'),
        hotkeyKey: store.get('hotkeyKey'),
        presetPrompts: store.get('presetPrompts'),
        model: store.get('model'),
        providerOrder: store.get('providerOrder')
    };
});

ipcMain.handle('set-config', (event, newConfig) => {
    // Ensure store is initialized before accessing
    if (!store) return { success: false, error: 'Store not ready' };
    try {
        console.log('Received new config:', newConfig);
        if (newConfig.apiKey !== undefined) store.set('apiKey', newConfig.apiKey);
        if (newConfig.presetPrompts !== undefined) store.set('presetPrompts', newConfig.presetPrompts);
        if (newConfig.model !== undefined) store.set('model', newConfig.model);
        if (newConfig.providerOrder !== undefined) store.set('providerOrder', newConfig.providerOrder);
        // Hotkey update requires re-registering
        let shortcutChanged = false;
        if (newConfig.hotkeyModifier !== undefined && newConfig.hotkeyModifier !== store.get('hotkeyModifier')) {
            store.set('hotkeyModifier', newConfig.hotkeyModifier);
            shortcutChanged = true;
        }
        if (newConfig.hotkeyKey !== undefined && newConfig.hotkeyKey !== store.get('hotkeyKey')) {
            store.set('hotkeyKey', newConfig.hotkeyKey);
            shortcutChanged = true;
        }

        if (shortcutChanged) {
            console.log('Hotkey changed, re-registering...');
            globalShortcut.unregisterAll(); // Unregister old one(s)
            registerShortcut(); // Register new one
        }
        return { success: true };
    } catch (error) {
        console.error('Failed to set config:', error);
        return { success: false, error: error.message };
    }
});

// Listener to open settings from prompt window (Removed)
// ipcMain.on('open-settings-window', () => { ... });