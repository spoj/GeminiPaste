use arboard::Clipboard;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{ImageEncoder, codecs::png::PngEncoder};
use ini::Ini;
use reqwest::blocking::Client; // Added reqwest client
use serde::{Deserialize, Serialize}; // Added serde traits
use simplelog::*;
use std::fs::File;
use std::io::Cursor;
use std::path::PathBuf;
use thiserror::Error;
// Define custom errors for the application
#[derive(Error, Debug)]
enum AppError {
    #[error("Configuration error: {0}")]
    Config(String),
    #[error("Clipboard error: {0}")]
    Clipboard(String),
    #[error("Image processing error: {0}")]
    Image(String),
    #[error("API request error: {0}")]
    Api(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Logging setup error: {0}")]
    LogSetup(String),
    // Add more specific errors as needed
}

// Type alias for Result using our custom error type
type Result<T> = std::result::Result<T, AppError>;

// Enum to represent clipboard content type
#[derive(Debug)]
enum ClipboardContent {
    Text(String),
    Image { base64_png: String }, // Store base64 encoded PNG
}

// Struct to hold application configuration
#[derive(Debug)]
struct Config {
    api_key: String,
    system_prompt: Option<String>, // Optional
}

// --- API Request/Response Structs ---

#[derive(Serialize, Debug)]
struct ApiRequest<'a> {
    model: &'a str,
    messages: Vec<Message<'a>>,
    max_tokens: u32,
}

#[derive(Serialize, Debug)]
struct Message<'a> {
    role: &'a str,
    content: MessageContent<'a>,
}

#[derive(Serialize, Debug)]
#[serde(untagged)] // Allows content to be either String or Vec<ContentPart>
enum MessageContent<'a> {
    Text(&'a str),
    Parts(Vec<ContentPart<'a>>),
}

#[derive(Serialize, Debug)]
struct ContentPart<'a> {
    #[serde(rename = "type")]
    part_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_url: Option<ImageUrl>, // Removed lifetime argument here too
}

#[derive(Serialize, Debug)]
struct ImageUrl {
    // Removed unused lifetime 'a
    url: String,
}

#[derive(Deserialize, Debug)]
struct ApiResponse {
    choices: Vec<Choice>,
    // Add other fields if needed, e.g., usage
}

#[derive(Deserialize, Debug)]
struct Choice {
    message: ResponseMessage,
}

#[derive(Deserialize, Debug)]
struct ResponseMessage {
    content: String,
}

// Optional: Struct for parsing API error responses
#[derive(Deserialize, Debug)]
struct ApiErrorResponse {
    error: ApiErrorDetail,
}

#[derive(Deserialize, Debug)]
struct ApiErrorDetail {
    message: String,
    #[serde(rename = "type")]
    error_type: Option<String>,
    code: Option<String>,
}

// --- End API Structs ---

fn main() {
    if let Err(e) = setup_logging() {
        eprintln!("Fatal: Failed to set up logging: {}", e);
        std::process::exit(1);
    }

    if let Err(e) = run_app() {
        log::error!("Application error: {}", e); // Log the detailed error
        eprintln!("Error processing request. See gemini_processor_error.log for details."); // Generic message to stderr
        std::process::exit(1);
    }
}

fn setup_logging() -> Result<()> {
    // Get the directory of the executable
    let exe_path = std::env::current_exe()?;
    let log_dir = exe_path
        .parent()
        .ok_or_else(|| AppError::LogSetup("Failed to get executable directory".to_string()))?;
    let log_file_path = log_dir.join("gemini_processor_error.log");

    // Configure logging to a file
    WriteLogger::init(
        LevelFilter::Info, // Log level
        simplelog::Config::default(),
        File::create(&log_file_path).map_err(|e| {
            AppError::LogSetup(format!(
                "Failed to create log file '{}': {}",
                log_file_path.display(),
                e
            ))
        })?,
    )
    .map_err(|e| AppError::LogSetup(format!("Failed to initialize logger: {}", e)))?;

    log::info!(
        "Logging initialized successfully to {}",
        log_file_path.display()
    );
    Ok(())
}

fn get_executable_dir() -> Result<PathBuf> {
    let exe_path = std::env::current_exe()?;
    exe_path
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| AppError::Config("Failed to get executable directory".to_string()))
}

fn read_config() -> Result<Config> {
    let config_dir = get_executable_dir()?;
    let config_path = config_dir.join("config.ini");
    log::info!("Attempting to read config from: {}", config_path.display());

    if !config_path.exists() {
        return Err(AppError::Config(format!(
            "Config file not found at {}",
            config_path.display()
        )));
    }

    let conf = Ini::load_from_file(&config_path)
        .map_err(|e| AppError::Config(format!("Failed to load config file: {}", e)))?;

    let section = conf
        .section(Some("Gemini"))
        .ok_or_else(|| AppError::Config("Missing [Gemini] section in config.ini".to_string()))?;

    let api_key = section
        .get("ApiKey")
        .ok_or_else(|| AppError::Config("Missing 'ApiKey' in [Gemini] section".to_string()))?
        .trim()
        .to_string();

    // Validate API key format (basic check)
    if api_key.is_empty() || !api_key.starts_with("sk-or-v1-") {
        return Err(AppError::Config(
            "Invalid 'ApiKey' format in [Gemini] section. Must start with 'sk-or-v1-'.".to_string(),
        ));
    }

    let system_prompt = section
        .get("SystemPrompt")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()); // Treat empty string as None

    log::info!("Config loaded successfully.");
    Ok(Config {
        api_key,
        system_prompt,
    })
}

fn get_clipboard_content() -> Result<ClipboardContent> {
    log::info!("Accessing clipboard...");
    let mut clipboard = Clipboard::new()
        .map_err(|e| AppError::Clipboard(format!("Failed to initialize clipboard: {}", e)))?;

    // Try getting image first
    match clipboard.get_image() {
        Ok(img_data) => {
            log::info!(
                "Clipboard contains image ({}x{})",
                img_data.width,
                img_data.height
            );

            // Create image buffer from raw data (assuming RGBA)
            // Note: arboard provides data in BGRA on Windows, need conversion or correct interpretation
            // For simplicity, let's assume RGBA for now, might need adjustment based on testing
            // A safer approach would be to check img_data format if possible or use a conversion library
            let image_buffer = image::RgbaImage::from_raw(
                img_data.width as u32,
                img_data.height as u32,
                img_data.bytes.into_owned(), // Convert Cow<[u8]> to Vec<u8>
            )
            .ok_or_else(|| {
                AppError::Image(
                    "Failed to create image buffer from clipboard data (check format/dimensions)"
                        .to_string(),
                )
            })?;

            // Encode image to PNG in memory
            let mut png_buffer = Vec::new();
            let mut cursor = Cursor::new(&mut png_buffer); // Use Cursor for Write trait
            let encoder = PngEncoder::new(&mut cursor); // Pass mutable reference to cursor

            encoder
                .write_image(
                    &image_buffer, // Pass reference to buffer
                    image_buffer.width(),
                    image_buffer.height(),
                    image::ExtendedColorType::Rgba8, // Use ExtendedColorType
                )
                .map_err(|e| AppError::Image(format!("Failed to encode image to PNG: {}", e)))?;

            // Base64 encode the PNG data
            let base64_png = STANDARD.encode(&png_buffer);
            log::info!("Image successfully encoded to Base64 PNG.");

            Ok(ClipboardContent::Image { base64_png })
        }
        Err(arboard::Error::ContentNotAvailable) => {
            log::info!("Clipboard does not contain image, checking for text...");
            // If no image, try getting text
            match clipboard.get_text() {
                Ok(text) => {
                    if text.trim().is_empty() {
                        log::warn!("Clipboard contains text format, but the text is empty.");
                        Err(AppError::Clipboard("Clipboard text is empty.".to_string()))
                    } else {
                        log::info!("Clipboard contains text.");
                        log::debug!(
                            "Clipboard text content (first 100 chars): '{}'",
                            &text.chars().take(100).collect::<String>()
                        ); // Log first 100 chars
                        Ok(ClipboardContent::Text(text))
                    }
                }
                Err(arboard::Error::ContentNotAvailable) => {
                    log::warn!("Clipboard does not contain supported image or text format.");
                    Err(AppError::Clipboard(
                        "Clipboard is empty or contains unsupported data.".to_string(),
                    ))
                }
                Err(e) => {
                    log::error!("Error getting text from clipboard: {}", e);
                    Err(AppError::Clipboard(format!(
                        "Failed to get text from clipboard: {}",
                        e
                    )))
                }
            }
        }
        Err(e) => {
            log::error!("Error getting image from clipboard: {}", e);
            Err(AppError::Clipboard(format!(
                "Failed to get image from clipboard: {}",
                e
            )))
        }
    }
}

fn call_api(config: &Config, content: &ClipboardContent) -> Result<String> {
    log::info!("Preparing API request...");
    let client = Client::new();
    let api_url = "https://openrouter.ai/api/v1/chat/completions";
    let model_name = "google/gemini-2.0-flash-001"; // Using vision model for potential images

    let mut messages: Vec<Message> = Vec::new();

    // Add system prompt if present
    if let Some(prompt) = &config.system_prompt {
        messages.push(Message {
            role: "system",
            content: MessageContent::Text(prompt),
        });
        log::debug!("Added system prompt.");
    }

    // Add user message based on clipboard content
    match content {
        ClipboardContent::Text(text) => {
            messages.push(Message {
                role: "user",
                content: MessageContent::Text(text),
            });
            log::debug!("Added user text message.");
        }
        ClipboardContent::Image { base64_png } => {
            let image_url_string = format!("data:image/png;base64,{}", base64_png);
            messages.push(Message {
                role: "user",
                content: MessageContent::Parts(vec![
                    ContentPart {
                        part_type: "text",
                        text: Some("Describe this image."), // Default prompt for images
                        image_url: None,
                    },
                    ContentPart {
                        part_type: "image_url",
                        text: None,
                        image_url: Some(ImageUrl {
                            url: image_url_string,
                        }),
                    },
                ]),
            });
            log::debug!("Added user image message.");
        }
    }

    let request_body = ApiRequest {
        model: model_name,
        messages,
        max_tokens: 1024, // As per original AHK script
    };

    log::info!("Sending API request to OpenRouter...");
    log::debug!("API Request Body: {:?}", request_body); // Log the request body
    let response = client
        .post(api_url)
        .bearer_auth(&config.api_key)
        .json(&request_body)
        .send()
        .map_err(|e| AppError::Api(format!("Network request failed: {}", e)))?;

    let status = response.status();
    log::info!("API response status: {}", status);

    if status.is_success() {
        let response_body: ApiResponse = response.json().map_err(|e| {
            AppError::Api(format!(
                "Failed to parse successful API response JSON: {}",
                e
            ))
        })?;

        if let Some(choice) = response_body.choices.get(0) {
            log::info!("Successfully extracted text from API response.");
            Ok(choice.message.content.clone())
        } else {
            log::error!("API response successful, but no 'choices' found in the response body.");
            Err(AppError::Api(
                "Invalid API response format: missing 'choices'".to_string(),
            ))
        }
    } else {
        // Attempt to parse error response
        let error_text = response
            .text()
            .unwrap_or_else(|_| "Failed to read error body".to_string());
        log::error!(
            "API request failed. Status: {}. Body: {}",
            status,
            error_text
        );

        // Try parsing the known error structure
        let specific_error_msg = match serde_json::from_str::<ApiErrorResponse>(&error_text) {
            Ok(parsed_error) => format!("API Error: {}", parsed_error.error.message),
            Err(_) => format!(
                "API request failed with status {}. Response body: {}",
                status, error_text
            ),
        };
        Err(AppError::Api(specific_error_msg))
    }
}

fn run_app() -> Result<()> {
    log::info!("Starting Gemini Processor...");

    // 1. Read Config
    let config = read_config()?;
    log::debug!(
        "Config loaded: ApiKey present, SystemPrompt: {:?}",
        config.system_prompt.is_some()
    );

    // 2. Access Clipboard & Process Image (if needed)
    let clipboard_content = get_clipboard_content()?;
    log::debug!("Clipboard content type: {:?}", clipboard_content); // Use debug level

    // 4. Call API
    let generated_text = call_api(&config, &clipboard_content)?;

    // 5. Print result to stdout
    println!("{}", generated_text); // Print only the final result to stdout
    log::info!("Processing finished successfully. Result printed to stdout.");

    Ok(())
}
