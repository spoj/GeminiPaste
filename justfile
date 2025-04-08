# Justfile for GeminiPaste Electron App

# Default recipe (runs the app in dev mode)
default: run

# Run the application in development mode
run:
    npm start

# Build the Windows NSIS installer
# Requires Wine/Docker on Linux for full Windows build capabilities
build-win:
    npm run build -- --win

# Clean build artifacts
clean:
    rm -rf dist/