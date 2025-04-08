console.log('settingsRenderer.js executing');

const apiKeyInput = document.getElementById('apiKey');
const modifierSelect = document.getElementById('hotkeyModifier');
const keyInput = document.getElementById('hotkeyKey');
const saveButton = document.getElementById('saveButton');
const statusMessage = document.getElementById('statusMessage');

// Load current settings when the window loads
window.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM Content Loaded. Requesting config...');
    try {
        const config = await window.electronAPI.getConfig();
        console.log('Received config:', config);
        if (config) {
            apiKeyInput.value = config.apiKey || '';
            modifierSelect.value = config.hotkeyModifier || 'Shift';
            keyInput.value = config.hotkeyKey || 'V';
        } else {
             console.error('Failed to load config or config is empty.');
             statusMessage.textContent = 'Error: Could not load settings.';
             statusMessage.classList.add('error');
        }
    } catch (error) {
        console.error('Error loading config:', error);
        statusMessage.textContent = `Error loading settings: ${error.message}`;
        statusMessage.classList.add('error');
    }
});

// Save settings when the button is clicked
saveButton.addEventListener('click', async () => {
    const newConfig = {
        apiKey: apiKeyInput.value.trim(),
        hotkeyModifier: modifierSelect.value,
        hotkeyKey: keyInput.value.trim().toUpperCase() // Ensure key is uppercase
    };

    // Basic validation for the key
    if (newConfig.hotkeyKey.length !== 1 || !/^[A-Z0-9]$/.test(newConfig.hotkeyKey)) {
         statusMessage.textContent = 'Error: Hotkey Key must be a single letter or number.';
         statusMessage.classList.remove('status');
         statusMessage.classList.add('error');
         return;
    }


    console.log('Saving new config:', newConfig);
    statusMessage.textContent = 'Saving...';
    statusMessage.classList.remove('error');
    statusMessage.classList.add('status');


    try {
        const result = await window.electronAPI.setConfig(newConfig);
        console.log('Save result:', result);
        if (result.success) {
            statusMessage.textContent = 'Settings saved successfully!';
            statusMessage.classList.remove('error');
            statusMessage.classList.add('status');
            // Optionally close the window after saving
            // window.close();
        } else {
            statusMessage.textContent = `Error saving settings: ${result.error || 'Unknown error'}`;
            statusMessage.classList.remove('status');
            statusMessage.classList.add('error');
        }
    } catch (error) {
        console.error('Error saving config:', error);
        statusMessage.textContent = `Error saving settings: ${error.message}`;
        statusMessage.classList.remove('status');
        statusMessage.classList.add('error');
    }
});

console.log('settingsRenderer.js finished executing.');