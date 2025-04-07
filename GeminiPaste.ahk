#Requires AutoHotkey v2.0
#SingleInstance Force

RunOutput(command) {
    shell := ComObject("WScript.Shell")
    tempFile := A_Temp . "\ahk_stdout_" . A_TickCount . ".tmp" ; Unique temp file path
    fullCommand := A_ComSpec . ' /c ""' . command . '" > "' . tempFile . '""' ; Command with redirection
    
    ; Run the command: 0 = hidden window, true = wait for completion
    shell.Run(fullCommand, 0, true)
    
    stdout := ""
    try {
        ; Read the output from the temp file
        file := FileOpen(tempFile, "r", "UTF-8")
        if IsObject(file) {
            stdout := file.Read()
            file.Close()
        }
    } catch Error as e {
        ; Handle potential errors reading the file
        stdout := "Error reading temp file: " e.Message
    } finally {
        ; Ensure the temp file is deleted
        try FileDelete(tempFile)
        catch
        {} ; Ignore errors if deletion fails (e.g., file not found)
    }
    
    return stdout
}

+#v::SendInput(RunOutput('"' A_ScriptDir '\gemini_processor.exe"'))