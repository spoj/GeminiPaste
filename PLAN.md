# Plan for GeminiPaste.ahk Script

This document outlines the plan for creating an AutoHotkey (AHK) v2 script that uses the `Windows+Alt+V` hotkey to send clipboard content to the Gemini 1.5 Flash API and paste the response.

**1. Project Files:**

*   **`GeminiPaste.ahk`**: The main AutoHotkey v2 script containing the logic.
*   **`config.ini`**: A configuration file to securely store the Gemini API key.

**2. `config.ini` Structure:**

This file will contain the API key under a specific section:

```ini
[Gemini]
ApiKey=YOUR_API_KEY_HERE
```
*Note: The user must replace `YOUR_API_KEY_HERE` with their actual Gemini API key.*

**3. `GeminiPaste.ahk` Logic:**

*   **Initialization:**
    *   Use `#Requires AutoHotkey v2.0`.
    *   Use `#SingleInstance Force`.
*   **Hotkey Definition:**
    *   Define `#!v` (Windows + Alt + V) to trigger `GeminiPasteFunc`.
*   **Main Function (`GeminiPasteFunc`):**
    1.  **Read API Key:** Read `ApiKey` from `[Gemini]` section of `config.ini`. Show Tooltip error if missing.
    2.  **Get Clipboard:** Read `A_Clipboard`. Show Tooltip error if empty.
    3.  **Prepare API Request:**
        *   Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=YOUR_API_KEY`
        *   JSON Payload:
            ```json
            {
              "contents": [{
                "parts": [{"text": "CLIPBOARD_CONTENT"}]
              }]
            }
            ```
    4.  **Send API Request:** Use `WebRequest` (or similar) to send POST request with key in URL and JSON body (`Content-Type: application/json`).
    5.  **Handle API Response:** Check HTTP status. Show Tooltip error on failure. Parse JSON response.
    6.  **Extract Text:** Extract text (e.g., from `response.candidates[0].content.parts[0].text`). Show Tooltip error if not found.
    7.  **Paste Result:** Use `SendInput` to paste the extracted text.
*   **Error Handling:** Use `ToolTip` for errors (config missing, empty clipboard, API/network issues).

**4. Workflow Diagram:**

```mermaid
sequenceDiagram
    participant User
    participant AHK Script (GeminiPaste.ahk)
    participant Config File (config.ini)
    participant Gemini API

    User->>+AHK Script: Presses Win+Alt+V
    AHK Script->>+Config File: Read API Key
    Config File-->>-AHK Script: Return API Key
    Note right of AHK Script: On Error: Show Tooltip & Exit
    AHK Script->>AHK Script: Get Clipboard Content (A_Clipboard)
    Note right of AHK Script: On Error (Empty): Show Tooltip & Exit
    AHK Script->>AHK Script: Prepare JSON Request Body
    AHK Script->>+Gemini API: Send POST Request (URL + Key + JSON)
    Gemini API-->>-AHK Script: Return JSON Response / Error Status
    Note right of AHK Script: On Error (Network/API): Show Tooltip & Exit
    AHK Script->>AHK Script: Parse JSON Response, Extract Text
    Note right of AHK Script: On Error (Parsing/Missing Text): Show Tooltip & Exit
    AHK Script->>User: Paste Extracted Text (SendInput)