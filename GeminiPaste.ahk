#Requires AutoHotkey v2.0
#SingleInstance Force
; --- Global Variables ---
Global PTOKEN := 0 ; GDI+ Token (Initialize as 0)

; --- GDI+ Shutdown Function ---
Gdiplus_Shutdown(ExitReason?, ExitCode?) { ; Add optional params for OnExit
    Global PTOKEN
    if PTOKEN {
        DllCall("gdiplus\GdiplusShutdown", "UPtr", PTOKEN)
        PTOKEN := "" ; Reset token
    }
}
; OnExit registration moved back into SaveClipboardImageToFile after successful startup


; Define the hotkey Win+Alt+V
#!v::GeminiPasteFunc()

GeminiPasteFunc() {
    ; --- Configuration ---
    local configPath := A_ScriptDir . "\config.ini"
    local apiKey := ""
    local systemPrompt := "" ; Initialize system prompt variable
    local openRouterUrl := "https://openrouter.ai/api/v1/chat/completions"
    local errorTimeoutMs := 3000 ; How long ToolTips should display in milliseconds
    ; --- 1. Read API Key ---
    try {
        apiKey := IniRead(configPath, "Gemini", "ApiKey", "")
        ; Check if the key is empty or doesn't start with the expected prefix
        if (apiKey = "" || !SubStr(apiKey, 1, 9) == "sk-or-v1-") {
             ShowToolTip("Error: OpenRouter API Key invalid, missing, or doesn't start with 'sk-or-v1-' in " . configPath, errorTimeoutMs)
            return
        }
    } catch {
        ShowToolTip("Error: Could not read config file: " . configPath, errorTimeoutMs)
        return
    }
    ; Read System Prompt (optional)
    systemPrompt := IniRead(configPath, "Gemini", "SystemPrompt", "") ; Read system prompt, default to empty if not found

    ; --- 2. Get Clipboard Content & Type ---
    ; Use ClipWait and ClipboardHasFormat for reliability
    local clipboardContent := ""
    local base64Image := ""
    local tempImagePath := ""
    local isText := false
    local isImage := false
    Sleep 200 ; Short delay to allow clipboard to stabilize instead of ClipWait
    ; if !ClipWait(2) { ; Wait up to 2 seconds for clipboard data - Removed based on user feedback
    ;     ShowToolTip("Error: Clipboard empty or timeout.", errorTimeoutMs)
    ;     return
    ; }
 
    if DllCall("IsClipboardFormatAvailable", "UInt", 1, "Int") { ; CF_TEXT = 1
        clipboardContent := A_Clipboard
        if Trim(clipboardContent) != "" {
            isText := true
        } else {
            ; Handle case where clipboard has text format but content is empty
             ShowToolTip("Error: Clipboard text is empty.", errorTimeoutMs)
             return
        }
    } else if DllCall("IsClipboardFormatAvailable", "UInt", 8, "Int") || DllCall("IsClipboardFormatAvailable", "UInt", 2, "Int") { ; CF_DIB = 8 or CF_BITMAP = 2
        isImage := true
        ; Default prompt for images, can be customized later
        clipboardContent := "Describe this image."
        ; Image saving/encoding happens below only if isImage is true
    } else {
         ShowToolTip("Error: Clipboard contains unsupported data.", errorTimeoutMs)
         return
    }
 
    ; --- Image Processing (only if needed) ---
    if (isImage) {
         tempImagePath := A_Temp . "\GeminiPaste_Temp_" . A_TickCount . ".png"
         if !SaveClipboardImageToFile(tempImagePath) {
             ShowToolTip("Error: Failed to save clipboard image.", errorTimeoutMs)
             return
         }
         base64Image := Base64EncodeFile(tempImagePath)
         if (base64Image = "") {
             ShowToolTip("Error: Failed to encode image.", errorTimeoutMs)
             FileDelete(tempImagePath) ; Clean up temp file
             return
         }
    }
 
    ; --- 3. Prepare API Request ---
    local messages := []

    ; Add system prompt if it exists
    if (Trim(systemPrompt) != "") {
        messages.Push(Map("role", "system", "content", systemPrompt))
    }

    ; Add user message (text or image)
    if (isText) { ; Text-only request
         messages.Push(Map("role", "user", "content", clipboardContent))
    } else if (isImage) { ; Multimodal request (Image + Text Prompt)
         messages.Push(Map("role", "user", "content", [
             Map("type", "text", "text", clipboardContent), ; Use the default prompt set earlier
             Map("type", "image_url", "image_url", Map("url", "data:image/png;base64," . base64Image))
         ]))
    }
    ; No final else needed here as unsupported formats are caught earlier
    local requestBody := Map(
        "model", "google/gemini-2.0-flash-001", ; Ensure model supports multimodal
        "messages", messages,
        "max_tokens", 1024 ; Optional: Increase max tokens for potentially longer image descriptions
    )
    local jsonRequestBody := JsonDump(requestBody)

    ; --- 4. Send API Request ---
    try {
        whr := ComObject("WinHttp.WinHttpRequest.5.1")
        whr.Open("POST", openRouterUrl)
        whr.SetRequestHeader("Content-Type", "application/json")
        whr.SetRequestHeader("Authorization", "Bearer " . apiKey) ; Add Auth header
        ; Add error handling for potential network issues during Send
        try {
             whr.Send(jsonRequestBody)
        } catch as e {
             ShowToolTip("Error: Network request failed. " e.Message, errorTimeoutMs)
             return
        }


        ; --- 5. Handle API Response ---
        local responseStatus := whr.Status
        local responseBody := whr.ResponseText
        OutputDebug("DEBUG: API Response Status: " . responseStatus) ; <-- Log status immediately
        FileAppend("Status: " . responseStatus . "`nBody:`n" . responseBody, A_ScriptDir . "\response_debug.log") ; <-- Log status and body immediately
        if (responseStatus != 200) {
            local errorMsg := "Error: API request failed. Status: " . whr.Status
            try {
                local errorResponse := JsonLoad(responseBody) ; Use variable
                if errorResponse.Has("error") && errorResponse["error"].Has("message") {
                    errorMsg .= ". Message: " . errorResponse["error"]["message"]
                }
            } catch {
                ; Ignore if response is not valid JSON
            }
            ShowToolTip(errorMsg, errorTimeoutMs)
            return
        }
 
        ; --- 6. Extract Text ---
        ; Removed pre-emptive logging line
        local responseObj := JsonLoad(responseBody) ; Use variable
        local generatedText := ""

        ; Parse OpenRouter/OpenAI format: response.choices[0].message.content
        if responseObj.Has("choices")
           && IsObject(responseObj["choices"])
           && responseObj["choices"].Length > 0
           && responseObj["choices"][1].Has("message")
           && responseObj["choices"][1]["message"].Has("content")
        {
             generatedText := responseObj["choices"][1]["message"]["content"]
        } else {
            ShowToolTip("Error: Could not extract text from API response. Check response_debug.log", errorTimeoutMs)
            ; For debugging: Log the response structure
            ; FileAppend moved to before JsonLoad call
            return
        }

        ; --- 7. Paste Result ---
        Send "{Blind}{Alt up}" ; Ensure Alt key is released before pasting
        SendInput(generatedText)

    } catch as e {
        ShowToolTip("Error during API interaction: " . e.Message, errorTimeoutMs)
    } finally {
        ; --- 8. Cleanup ---
        if (tempImagePath != "" && FileExist(tempImagePath)) {
            FileDelete(tempImagePath)
        }
    }
}

; Helper function to show a tooltip and remove it after a delay
ShowToolTip(text, timeout) {
    ToolTip(text)
    SetTimer () => ToolTip(), -Abs(timeout) ; Negative value makes it run once
}

; Basic JSON functions (replace with a proper library if needed for robustness)
; NOTE: AHK v2 might have built-in JSON support eventually.
; These are very basic implementations.
JsonDump(obj) {
    local jsonString := ""
    if IsObject(obj) {
        if obj is Map { ; Handle Map (like JSON object)
            jsonString .= "{"
            local first := true
            for k, v in obj {
                if !first
                    jsonString .= ","
                jsonString .= JsonDump(k) . ":" . JsonDump(v)
                first := false
            }
            jsonString .= "}"
        } else { ; Handle Array (like JSON array)
             jsonString .= "["
             local first := true
             Loop obj.Length {
                 if !first
                     jsonString .= ","
                 jsonString .= JsonDump(obj[A_Index])
                 first := false
             }
             jsonString .= "]"
        }
    } Else If (Type(obj) == "String") {
        ; Basic string escaping (needs improvement for full compliance)
        local escaped := StrReplace(obj, "\", "\\")
        escaped := StrReplace(escaped, '"', '\"')
        escaped := StrReplace(escaped, "/", "\/")
        escaped := StrReplace(escaped, "`n", "\n")
        escaped := StrReplace(escaped, "`r", "\r")
        escaped := StrReplace(escaped, "`t", "\t")
        jsonString .= '"' . escaped . '"'
    } Else If IsNumber(obj) {
        jsonString .= obj
    } Else If (Type(obj) == "Boolean") {
        jsonString .= obj ? "true" : "false"
    } Else If !IsSet(obj) { ; Check if the variable is unset
        jsonString .= "null"
    } else {
        jsonString .= '"' . obj . '"' ; Fallback for other types (like objects not handled above)
    }
    return jsonString
}

; Very basic JSON Load - Highly recommend using a library or built-in function
; This is NOT a robust parser.
JsonLoad(jsonString) {
    ; Placeholder: A real implementation is complex.
    ; For this script's specific need, we might get away with regex or string manipulation
    ; if the response structure is guaranteed, but that's fragile.
    ; Example using basic regex for the expected path (VERY FRAGILE):
    ; Updated basic parsing for OpenRouter/OpenAI structure (still fragile)
    ; It's generally better to use a robust JSON library if available.
    ; Use simpler regex targeting "content" directly
    if RegExMatch(jsonString, '(?s)"content"\s*:\s*"((?:[^"\\]|\\.)*)"', &match) {
        local text := match[1]
        ; Basic unescaping (same as before)
        text := StrReplace(text, '\"', '"')
        text := StrReplace(text, '\\', '\')
        text := StrReplace(text, '\/', '/')
        text := StrReplace(text, '\n', "`n")
        text := StrReplace(text, '\r', "`r")
        text := StrReplace(text, '\t', "`t")

        ; Construct a Map mimicking the expected structure for the check in GeminiPasteFunc
        return Map(
            "choices", [Map(
                "message", Map(
                    "content", text
                )
            )]
        )
    } else {
         throw Error("Basic JsonLoad failed: Could not parse expected OpenRouter structure.")
    }
    ; return Map() ; Return empty map on failure
}
 
; --- Helper Functions for Image Handling ---
 
; Saves the image currently on the clipboard to a file (e.g., PNG)
; Requires GDI+ to be initialized. Basic implementation included.
SaveClipboardImageToFile(filePath) {
    Global PTOKEN ; Access the global token
    local hModule, si, status, hBitmap, pBitmap, encoderClsid

    ; --- Initialize GDI+ if not already done ---
    if !PTOKEN {
        hModule := DllCall("LoadLibrary", "Str", "gdiplus.dll", "Ptr")
        if !hModule {
            OutputDebug("ERROR: Failed to load gdiplus.dll")
            ShowToolTip("Error: Failed to load gdiplus.dll", 3000)
            return false
        }
        si := Buffer(A_PtrSize=8 ? 24 : 16, 0)
        OutputDebug("DEBUG: si type: " . Type(si) . ", si.ptr before check: " . si.ptr) ; <-- Add log 1
        if !IsObject(si) {
            OutputDebug("ERROR: Failed to create GDI+ buffer")
            ShowToolTip("Error: Failed to create GDI+ buffer", 3000)
            Return false ; Return instead of ExitApp
        }
        if !si.ptr { ; <-- Add explicit check for si.ptr being non-zero/non-null
             OutputDebug("DEBUG: si.ptr is invalid (zero or null)!") ; <-- Add log 2
             OutputDebug("ERROR: GDI+ buffer pointer is invalid.")
             ShowToolTip("Error: GDI+ buffer pointer is invalid.", 3000)
             Return false
        }
        NumPut("UInt", 1, si, 0) ; GdiplusVersion
        OutputDebug("DEBUG: si.ptr before GdiplusStartup DllCall: " . si.ptr) ; <-- Add log 3
        local startupStatus := DllCall("gdiplus\GdiplusStartup", "UPtr*", &PTOKEN, "Ptr", si.ptr, "Ptr", 0)
        if (startupStatus != 0) { ; Check only startupStatus, PTOKEN is output
            PTOKEN := "" ; Ensure PTOKEN is reset on failure
            OutputDebug("ERROR: GdiplusStartup failed. Status: " . startupStatus . ", PTOKEN: " . PTOKEN)
            ShowToolTip("Error: GdiplusStartup failed. Status: " . startupStatus . ", PTOKEN: " . PTOKEN, 3000) ; Add PTOKEN to log
            return false
        }
        ; Register shutdown only ONCE after successful startup
        OnExit(Gdiplus_Shutdown.Bind()) ; Register shutdown using BoundFunc
    }
    ; --- GDI+ is now guaranteed to be initialized (or function returned false) ---

    ; --- Get bitmap from clipboard ---
    if !DllCall("user32\OpenClipboard", "Ptr", 0) {
        OutputDebug("ERROR: Failed to open clipboard.")
        ShowToolTip("Error: Failed to open clipboard.", 3000)
        return false
    }
    hBitmap := DllCall("user32\GetClipboardData", "UInt", 2, "Ptr") ; CF_BITMAP = 2
    DllCall("user32\CloseClipboard")
    if !hBitmap {
        OutputDebug("ERROR: Failed to get bitmap handle from clipboard.")
        ShowToolTip("Error: Failed to get bitmap handle from clipboard.", 3000)
        return false
    }

    ; --- Create GDI+ Bitmap ---
    pBitmap := 0
    status := DllCall("gdiplus\GdipCreateBitmapFromHBITMAP", "Ptr", hBitmap, "Ptr", 0, "Ptr*", &pBitmap)
    if (status != 0 || !pBitmap) { ; Check pBitmap directly
        OutputDebug("ERROR: GdipCreateBitmapFromHBITMAP failed. Status: " . status)
        ShowToolTip("Error: GdipCreateBitmapFromHBITMAP failed. Status: " . status, 3000)
        return false
    }

    ; --- Get PNG Encoder CLSID ---
    encoderClsid := Buffer(16)
    if !GetEncoderClsid("image/png", encoderClsid) { ; Pass buffer directly
        OutputDebug("ERROR: Failed to get PNG encoder CLSID.")
        ShowToolTip("Error: Failed to get PNG encoder CLSID.", 3000)
        DllCall("gdiplus\GdipDisposeImage", "Ptr", pBitmap) ; Clean up bitmap
        return false
    }

    ; --- Save Image ---
    status := DllCall("gdiplus\GdipSaveImageToFile", "Ptr", pBitmap, "WStr", filePath, "Ptr", encoderClsid.ptr, "Ptr", 0) ; Use .ptr here
    if (status != 0) {
        ShowToolTip("Error: GdipSaveImageToFile failed. Status: " . status, 3000) ; Revert tooltip
    }

    ; --- Clean up ---
    DllCall("gdiplus\GdipDisposeImage", "Ptr", pBitmap)

    return (status = 0)
}
 
; Helper for SaveClipboardImageToFile to get the encoder CLSID
GetEncoderClsid(format, pClsid) {
    local num := 0, size := 0, encoders, mimeTypePtr, clsidPtr, currentEncoderPtr, mimeTypeOffset

    DllCall("gdiplus\GdipGetImageEncodersSize", "UInt*", &num, "UInt*", &size)
    if (size = 0 || num = 0) { ; Also check num != 0
        ; Removed OutputDebug log
        ShowToolTip("Error: No image encoders found or size is zero.", 3000)
        return false
    }
    encoders := Buffer(size)
    local getEncodersStatus := DllCall("gdiplus\GdipGetImageEncoders", "UInt", num, "UInt", size, "Ptr", encoders.ptr) ; Capture status
    if (getEncodersStatus != 0) { ; Check if status is not OK (0)
         ; Removed OutputDebug log
         ShowToolTip("Error: GdipGetImageEncoders call failed. Status: " . getEncodersStatus, 3000)
         return false
    }

    local encoderSize := 48 + 7 * A_PtrSize ; Calculate size based on struct definition (Clsid+FormatID+5*Ptr+Flags+Version) - Perplexity method
    mimeTypeOffset := 32 + 4 * A_PtrSize ; Correct offset to MimeType pointer field within the structure
    ; Removed OutputDebug log

    Loop num {
        ; Removed OutputDebug log
        currentEncoderPtr := encoders.ptr + (A_Index - 1) * encoderSize
        ; Removed OutputDebug log
        clsidPtr := currentEncoderPtr ; CLSID is at the start of the struct

        ; Get the pointer to the MimeType string using the correct offset
        mimeTypePtr := NumGet(encoders, (A_Index - 1) * encoderSize + mimeTypeOffset, "Ptr")
        ; Removed OutputDebug log

        ; CRITICAL CHECK: Ensure the pointer is valid before using StrGet
        if (mimeTypePtr != 0) {
            local currentMimeType := StrGet(mimeTypePtr) ; Get the MIME type string
            ; Removed OutputDebug log
            if (currentMimeType = format) {
                ; Copy the CLSID GUID (16 bytes) to the output buffer pClsid
                DllCall("Kernel32\RtlMoveMemory", "Ptr", pClsid.ptr, "Ptr", clsidPtr, "Ptr", 16) ; pClsid is the buffer object, use .ptr
                return true
            }
        } else {
             ; Removed OutputDebug log
        }
    }
    ShowToolTip("Error: Encoder for format '" . format . "' not found.", 3000)
    return false
}
 
; Encodes the content of a file into Base64
Base64EncodeFile(filePath) {
    try {
        file := FileOpen(filePath, "r")
        if !IsObject(file)
            return ""
        size := file.Length
        binData := Buffer(size)
        file.RawRead(binData, size)
        file.Close()
 
        ; Use CryptBinaryToString for Base64 encoding
        CRYPT_STRING_BASE64 := 1
        CRYPT_STRING_NOCRLF := 0x40000000 ; Flag to prevent CRLF insertion
        strLen := 0
        ; First call to get the required length
        DllCall("Crypt32.dll\CryptBinaryToString", "Ptr", binData.ptr, "UInt", size, "UInt", CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, "Ptr", 0, "UInt*", &strLen)
        if (strLen = 0)
            return ""
        
        base64StrBuf := Buffer(strLen * 2) ; Allocate buffer (WCHAR size)
        if !DllCall("Crypt32.dll\CryptBinaryToString", "Ptr", binData.ptr, "UInt", size, "UInt", CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, "Ptr", base64StrBuf.ptr, "UInt*", &strLen)
            return ""
            
        return StrGet(base64StrBuf.ptr, strLen)
    } catch {
        return "" ; Return empty string on error
    }
}