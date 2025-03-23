import NotesSyncPlugin from './main';

/**
 * Helper class for Language Model operations
 */
export class LLMHelper {
    private plugin: NotesSyncPlugin;
    
    constructor(plugin: NotesSyncPlugin) {
        this.plugin = plugin;
    }
    
    /**
     * Generate a title for a note using LLM
     * @param content The content to generate a title for
     * @param llmType The type of LLM to use
     * @param llmModel The specific model to use
     * @param apiKey The API key for the LLM service
     * @returns A generated title, or an empty string if generation fails
     */
    public async generateTitle(
        content: string, 
        llmType?: string,
        llmModel?: string,
        apiKey?: string
    ): Promise<string> {
        // Use provided parameters or fallback to global settings, then service-specific settings
        const type = llmType || this.plugin.settings.llmType || this.plugin.settings.flomoLlmType;
        const model = llmModel || this.plugin.settings.llmModel || this.plugin.settings.flomoLlmModel;
        const key = apiKey || this.plugin.settings.llmApiKey || this.plugin.settings.flomoLlmApiKey;
        
        if (!key || !type) {
            return "";
        }
        
        try {
            let response;
            if (type === "ZhipuAI") {
                response = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${key}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [
                            {
                                role: "user",
                                content: `为以下内容提供一个简洁的标题，请避免使用特殊符号，例如: * . " \\ / < > : | ? 这些符号在文件名中是不允许的: "${content}"`,
                            },
                        ],
                        stream: false,
                    }),
                });
            } else if (type === "Tongyi") {
                response = await fetch("https://api.tongyi.com/v1/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${key}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        prompt: `Provide a concise title for the following content. IMPORTANT: Do not use any special characters like * . " \\ / < > : | ? as they are not allowed in filenames: "${content}"`,
                        max_tokens: 10,
                        model: model,
                    }),
                });
            } else if (type === "OpenAI") {
                response = await fetch("https://api.openai.com/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${key}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        model: model || "gpt-3.5-turbo",
                        messages: [
                            {
                                role: "system",
                                content: "You are a helpful assistant that creates concise, descriptive titles that do not contain any special characters."
                            },
                            {
                                role: "user",
                                content: `Create a concise title (maximum 5 words) for this content. IMPORTANT: Do not use any special characters like * . " \\ / < > : | ? as they are not allowed in filenames: "${content}"`
                            }
                        ],
                        max_tokens: 15
                    }),
                });
            } else {
                console.error("Unsupported LLM type.");
                return "";
            }
            
            if (!response.ok) {
                console.error(`LLM API error: ${response.status} ${response.statusText}`);
                return "";
            }
            
            const data = await response.json();
            
            // Different LLMs have different response formats
            let title = "";
            if (type === "OpenAI") {
                title = data.choices && data.choices.length > 0
                    ? data.choices[0].message.content.trim()
                    : "";
            } else {
                title = data.choices && data.choices.length > 0
                    ? data.choices[0].message.content.trim()
                    : "";
            }
            
            // Sanitize the title to remove invalid filename characters
            return this.sanitizeFilename(title);
        } catch (error) {
            console.error("Error generating title with LLM:", error);
            return "";
        }
    }
    
    /**
     * Sanitizes a string to make it safe for use as a filename
     * @param filename The string to sanitize
     * @returns A sanitized string with invalid characters replaced with underscores
     */
    private sanitizeFilename(filename: string): string {
        // Replace invalid characters with underscores
        let sanitized = filename.replace(/[*."\\/<>:|?]/g, '_');
        
        // Remove surrounding underscores (often from markdown formatting)
        sanitized = sanitized.replace(/^_+|_+$/g, '');
        
        // Also remove leading and trailing spaces and dots
        return sanitized.trim().replace(/^\.+|\.+$/g, '');
    }
} 