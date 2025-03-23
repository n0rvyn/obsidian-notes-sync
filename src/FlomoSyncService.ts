import { Notice, TFile } from 'obsidian';
import { FrontMatter, SyncService, SyncStatus } from './types';
import NotesSyncPlugin from './main';
import * as crypto from 'crypto';
import { LLMHelper } from './LLMHelper';

export class FlomoSyncService implements SyncService {
    private plugin: NotesSyncPlugin;
    private syncStatus: SyncStatus;
    private isSyncing: boolean;
    private cancelRequested: boolean;
    private salt = "dbbc3dd73364b4084c3a69346e0ce2b2";
    private frontMatterCache: Map<string, any>; // Cache for parsed frontmatter
    private fileModifiedTimes: Map<string, number>; // Track file modification times
    private llmHelper: LLMHelper;

    constructor(plugin: NotesSyncPlugin) {
        this.plugin = plugin;
        this.isSyncing = false;
        this.cancelRequested = false;
        this.frontMatterCache = new Map();
        this.fileModifiedTimes = new Map();
        this.llmHelper = new LLMHelper(plugin);
        this.syncStatus = {
            inProgress: false,
            lastSync: this.plugin.settings.lastSyncTime || 0,
            lastSyncId: '',
            pendingChanges: 0,
            errors: [],
            progress: {
                total: 0,
                completed: 0,
                currentFile: ''
            }
        };
    }

    public async syncFromServer(options?: { isAutoSync?: boolean, isFullSync?: boolean }): Promise<void> {
        const isFullSync = options?.isFullSync || false;
        
        if (this.isSyncing) {
            new Notice('Sync already in progress');
            return;
        }

        if (!this.plugin.settings.flomoApiToken) {
            new Notice('Flomo API token not set. Please configure in settings.');
            return;
        }

        this.isSyncing = true;
        this.cancelRequested = false;
        this.syncStatus.inProgress = true;
        this.syncStatus.progress = {
            total: 0,
            completed: 0,
            currentFile: 'Preparing to sync...'
        };

        try {
            // Ensure sync folder exists
            await this.ensureSyncFolderExists();
            
            // Fetch memos from server
            this.syncStatus.progress.currentFile = 'Fetching memos from Flomo...';
            new Notice('Starting sync from Flomo...');
            
            const memos = await this.fetchMemos();
            
            // Check if cancelled
            if (this.cancelRequested) {
                new Notice('Sync cancelled');
                return;
            }

            this.syncStatus.progress.total = memos.length;
            new Notice(`Fetched ${memos.length} memos from Flomo.`);

            if (memos.length === 0) {
                new Notice('No new memos to sync from Flomo.');
                return;
            }
            
            // Process each memo
            for (let i = 0; i < memos.length && !this.cancelRequested; i++) {
                const memo = memos[i];
                
                // Use LLM for title generation if configured
                if (this.shouldUseAiForTitleGeneration()) {
                    this.syncStatus.progress.currentFile = 'Generating title with AI...';
                    const generatedTitle = await this.llmHelper.generateTitle(
                        memo.content,
                        this.plugin.settings.flomoLlmType || this.plugin.settings.llmType,
                        this.plugin.settings.flomoLlmModel || this.plugin.settings.llmModel,
                        this.plugin.settings.flomoLlmApiKey || this.plugin.settings.llmApiKey
                    );
                    if (generatedTitle) {
                        memo.slug = generatedTitle;
                    }
                }
                
                this.syncStatus.progress.currentFile = memo.slug || memo.title || 'Untitled';
                this.syncStatus.progress.completed = i;
                
                await this.saveFlomoNoteToLocal(memo);
            }

            // Update last sync time
            this.plugin.settings.lastSyncTime = Date.now();
            this.syncStatus.lastSync = this.plugin.settings.lastSyncTime;
            await this.plugin.saveSettings();
            
            new Notice('Sync from Flomo completed!');
        } catch (err) {
            console.error("Sync error:", err);
            this.syncStatus.errors.push({
                file: '',
                error: err.message || String(err),
                timestamp: Date.now()
            });
            new Notice(`Sync error: ${err.message}`);
        } finally {
            this.isSyncing = false;
            this.syncStatus.inProgress = false;
        }
    }

    public async syncToServer(): Promise<void> {
        if (this.isSyncing) {
            new Notice('Sync already in progress');
            return;
        }

        if (!this.plugin.settings.flomoApiToken) {
            new Notice('Flomo API token not set. Please configure in settings.');
            return;
        }

        this.isSyncing = true;
        this.cancelRequested = false;
        this.syncStatus.inProgress = true;
        this.syncStatus.progress = {
            total: 0,
            completed: 0,
            currentFile: 'Preparing to sync to Flomo...'
        };

        try {
            // Find all markdown files in the specified folder
            const folderPath = this.plugin.settings.flomoSyncDirectory;
            const allFiles = this.plugin.app.vault.getMarkdownFiles();
            const syncFiles = allFiles.filter(file => 
                file.path.startsWith(folderPath)
            );

            this.syncStatus.progress.total = syncFiles.length;
            
            if (syncFiles.length === 0) {
                new Notice('No files found to sync to Flomo');
                return;
            }

            new Notice(`Found ${syncFiles.length} notes to sync to Flomo`);
            
            // Process each file
            let successCount = 0;
            let skipCount = 0;
            
            for (let i = 0; i < syncFiles.length && !this.cancelRequested; i++) {
                const file = syncFiles[i];
                this.syncStatus.progress.currentFile = file.name;
                this.syncStatus.progress.completed = i;
                
                // Read the file content
                const content = await this.plugin.app.vault.read(file);
                const frontMatter = this.parseFrontMatter(content);
                const noteContent = this.extractContentWithoutFrontmatter(content);
                
                // Skip files that already have been synced to Flomo
                if (frontMatter && frontMatter.memo_id) {
                    // This is an existing memo, update it on Flomo
                    const result = await this.updateMemoOnFlomo(frontMatter.memo_id, noteContent, frontMatter);
                    if (result.success) {
                        successCount++;
                    } else {
                        this.syncStatus.errors.push({
                            file: file.path,
                            error: result.message || "Failed to update memo on Flomo",
                            timestamp: Date.now()
                        });
                    }
                } else {
                    // This is a new note to sync to Flomo
                    const result = await this.createMemoOnFlomo(noteContent, frontMatter);
                    if (result.success) {
                        // Update the local file with the new memo_id
                        if (result.memo_id) {
                            const updatedFrontMatter = {
                                ...(frontMatter || {}),
                                memo_id: result.memo_id,
                                last_synced: Date.now(),
                                sync_status: 'synced'
                            };
                            
                            const updatedContent = this.formatNoteContent(updatedFrontMatter, noteContent);
                            await this.plugin.app.vault.modify(file, updatedContent);
                        }
                        successCount++;
                    } else {
                        this.syncStatus.errors.push({
                            file: file.path,
                            error: result.message || "Failed to create memo on Flomo",
                            timestamp: Date.now()
                        });
                    }
                }
            }

            // If cancelled
            if (this.cancelRequested) {
                new Notice('Sync to Flomo cancelled');
                return;
            }

            // Update last sync time
            this.plugin.settings.lastSyncTime = Date.now();
            this.syncStatus.lastSync = this.plugin.settings.lastSyncTime;
            await this.plugin.saveSettings();
            
            new Notice(`Sync to Flomo completed! ${successCount} notes synced, ${skipCount} skipped`);
        } catch (err) {
            console.error("Sync to Flomo error:", err);
            this.syncStatus.errors.push({
                file: '',
                error: err.message || String(err),
                timestamp: Date.now()
            });
            new Notice(`Sync to Flomo error: ${err.message}`);
        } finally {
            this.isSyncing = false;
            this.syncStatus.inProgress = false;
        }
    }

    public cancelSync(): void {
        if (!this.isSyncing) return;
        
        this.cancelRequested = true;
        new Notice('Cancelling Flomo sync operation...');
    }

    public getSyncStatus(): SyncStatus {
        return { ...this.syncStatus };
    }

    public async testConnection(): Promise<{ success: boolean; message: string }> {
        try {
            const apiToken = this.plugin.settings.flomoApiToken;

            if (!apiToken || apiToken.trim() === '') {
                return { 
                    success: false, 
                    message: 'No Flomo API token provided. Please set your token in the plugin settings.' 
                };
            }
            
            // Test connection using the same endpoint we use for syncing
            const params = this._getParams({});
            params.limit = 1; // Just get one memo to verify connectivity
            
            const url = new URL("https://flomoapp.com/api/v1/memo/updated");
            url.search = new URLSearchParams(params).toString();
            
            const response = await this.fetchWithTimeout(url.toString(), {
                method: "GET",
                headers: {
                    "authorization": `Bearer ${apiToken}`,
                    "Content-Type": "application/json",
                },
            }, 5000); // 5 second timeout for test
            
            if (!response.ok) {
                return {
                    success: false,
                    message: `Flomo API request failed: ${response.status} ${response.statusText}`
                };
            }
            
            const data = await response.json();
            
            if (data.code !== 0) {
                return {
                    success: false,
                    message: `Flomo API request failed: ${data.message || 'Unknown error'}`
                };
            }
            
            return {
                success: true,
                message: `Connection to Flomo successful! Your account is working properly.`
            };
        } catch (error) {
            if (error.name === 'AbortError') {
                return {
                    success: false,
                    message: `Connection to Flomo timed out. Please check your network.`
                };
            }
            
            return {
                success: false,
                message: `Flomo connection error: ${error.message}`
            };
        }
    }

    private async ensureSyncFolderExists(): Promise<void> {
        const folderPath = this.plugin.settings.flomoSyncDirectory;
        if (!folderPath) return;
        
        try {
            const folderExists = await this.plugin.app.vault.adapter.exists(folderPath);
            if (!folderExists) {
                await this.plugin.app.vault.createFolder(folderPath);
                new Notice(`Created Flomo sync folder: ${folderPath}`);
            }
        } catch (err) {
            console.error("Error ensuring Flomo sync folder exists:", err);
            throw new Error(`Failed to create Flomo sync folder: ${err.message}`);
        }
    }

    private _getParams(params: Record<string, any>): Record<string, any> {
        const paramsSorted: Record<string, any> = {
            limit: this.plugin.settings.flomoFetchLimit,
            tz: "8:0",
            timestamp: Math.floor(Date.now() / 1000).toString(),
            api_key: "flomo_web",
            app_version: "2.0",
            order: this.plugin.settings.flomoFetchOrder,
            token: this.plugin.settings.flomoApiToken,
        };
        
        if (params.latest_slug && params.latest_updated_at) {
            paramsSorted["latest_slug"] = params.latest_slug;
            paramsSorted["latest_updated_at"] = params.latest_updated_at;
        }
        
        const paramStr = Object.keys(paramsSorted)
            .sort()
            .map((key) => `${key}=${paramsSorted[key]}`)
            .join("&");
            
        const sign = crypto
            .createHash("md5")
            .update(paramStr + this.salt, "utf8")
            .digest("hex");
            
        return { ...paramsSorted, sign };
    }

    private async fetchMemos(retryCount = 0): Promise<any[]> {
        const token = this.plugin.settings.flomoApiToken;
        if (!token || token.trim() === '') {
            throw new Error('No Flomo API token provided. Please set your token in the plugin settings.');
        }

        let params: Record<string, any> = {};
        
        // Check if we have a last sync time to do incremental sync
        if (this.syncStatus.lastSync > 0) {
            // Find the latest synced memo to use as reference
            const latestSyncedMemo = await this.findLatestSyncedMemo();
            
            if (latestSyncedMemo) {
                console.log("Performing incremental sync using last synced memo as reference");
                params = {
                    latest_slug: latestSyncedMemo.slug,
                    latest_updated_at: latestSyncedMemo.updated_at
                };
            } else {
                console.log("No reference memo found for incremental sync, performing full sync");
            }
        }
        
        const requestParams = this._getParams(params);
        const url = new URL("https://flomoapp.com/api/v1/memo/updated");
        url.search = new URLSearchParams(requestParams).toString();
        
        console.log("Fetching memos from Flomo URL:", url.toString());
        
        try {
            const response = await this.fetchWithTimeout(url.toString(), {
                method: "GET",
                headers: {
                    "authorization": `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
            }, 30000); // 30 second timeout for larger requests
            
            if (!response.ok) {
                const errorMessage = `Failed to fetch memos: ${response.status} ${response.statusText}`;
                console.error(errorMessage);
                
                // Retry logic for server errors (5xx) or rate limiting (429)
                if ((response.status >= 500 || response.status === 429) && retryCount < 3) {
                    const retryDelay = Math.pow(2, retryCount) * 1000; // Exponential backoff
                    console.log(`Retrying in ${retryDelay}ms (attempt ${retryCount + 1})`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    return this.fetchMemos(retryCount + 1);
                }
                
                // Specific error messages for common issues
                if (response.status === 401) {
                    throw new Error('Authentication failed. Your Flomo API token may be invalid.');
                } else if (response.status === 403) {
                    throw new Error('Access denied. You do not have permission to access these memos.');
                } else if (response.status === 404) {
                    throw new Error('API endpoint not found. Flomo API may have changed.');
                } else if (response.status === 429) {
                    throw new Error('Rate limit exceeded. Please try again later.');
                }
                
                throw new Error(errorMessage);
            }
            
            const data = await response.json();
            if (data.code !== 0) {
                const errorMessage = `API error: ${data.message || JSON.stringify(data)}`;
                console.error(errorMessage);
                
                // Retry API errors with specific codes that might be temporary
                if ((data.code === 1001 || data.code === 1002) && retryCount < 3) {
                    const retryDelay = Math.pow(2, retryCount) * 1000;
                    console.log(`Retrying API error in ${retryDelay}ms (attempt ${retryCount + 1})`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    return this.fetchMemos(retryCount + 1);
                }
                
                throw new Error(errorMessage);
            }
            
            // Reset any view-related error messages on success
            const memos = data.data || [];
            console.log(`Successfully fetched ${memos.length} memos from Flomo`);
            return memos;
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error(`Request timed out. Check your network connection and try again.`);
            }
            
            console.error("Error fetching Flomo memos:", error);
            
            // Add more context to the error
            if (error.message) {
                throw new Error(`Error fetching Flomo memos: ${error.message}`);
            } else {
                throw error;
            }
        }
    }
    
    /**
     * Get frontmatter for a file, using cache if available
     */
    private async getFrontMatter(file: TFile): Promise<any | null> {
        const path = file.path;
        const modTime = file.stat.mtime;
        
        // Check if we have a cached version and if the file hasn't been modified
        if (this.frontMatterCache.has(path) && this.fileModifiedTimes.get(path) === modTime) {
            return this.frontMatterCache.get(path);
        }
        
        try {
            const content = await this.plugin.app.vault.read(file);
            const frontMatter = this.parseFrontMatter(content);
            
            // Cache the result
            this.frontMatterCache.set(path, frontMatter);
            this.fileModifiedTimes.set(path, modTime);
            
            return frontMatter;
        } catch (err) {
            console.error(`Error reading frontmatter from ${path}:`, err);
            return null;
        }
    }
    
    /**
     * Find an existing file that contains this memo_id in its frontmatter
     * This uses the frontmatter cache to improve performance
     */
    private async findExistingMemoFile(memoId: string): Promise<TFile | null> {
        const folderPath = this.plugin.settings.flomoSyncDirectory;
        
        // Get all markdown files in the sync directory and subdirectories
        const allFiles = this.plugin.app.vault.getMarkdownFiles();
        const syncFiles = allFiles.filter(file => 
            file.path.startsWith(folderPath)
        );
        
        // First check cache for quick lookup
        for (const file of syncFiles) {
            const path = file.path;
            const modTime = file.stat.mtime;
            
            // Use cached frontmatter if available and file hasn't changed
            if (this.frontMatterCache.has(path) && this.fileModifiedTimes.get(path) === modTime) {
                const frontMatter = this.frontMatterCache.get(path);
                if (frontMatter && frontMatter.memo_id === memoId) {
                    console.log(`Found existing memo ${memoId} in cache: ${path}`);
                    return file;
                }
            }
        }
        
        // If not found in cache, check files directly
        for (const file of syncFiles) {
            try {
                const frontMatter = await this.getFrontMatter(file);
                
                if (frontMatter && frontMatter.memo_id === memoId) {
                    console.log(`Found existing memo ${memoId} in file: ${file.path}`);
                    return file;
                }
            } catch (err) {
                console.error(`Error reading file ${file.path}:`, err);
                // Continue to next file
            }
        }
        
        return null;
    }
    
    /**
     * Find the most recently synced memo to use for incremental sync
     */
    private async findLatestSyncedMemo(): Promise<any | null> {
        const folderPath = this.plugin.settings.flomoSyncDirectory;
        
        // Get all markdown files in the sync directory and subdirectories
        const allFiles = this.plugin.app.vault.getMarkdownFiles();
        const syncFiles = allFiles.filter(file => 
            file.path.startsWith(folderPath)
        );
        
        if (syncFiles.length === 0) {
            return null;
        }
        
        let latestSyncTime = 0;
        let latestMemo = null;
        
        for (const file of syncFiles) {
            try {
                const frontMatter = await this.getFrontMatter(file);
                
                if (!frontMatter || !frontMatter.last_synced) continue;
                
                const syncTime = parseInt(frontMatter.last_synced);
                if (syncTime > latestSyncTime) {
                    latestSyncTime = syncTime;
                    latestMemo = {
                        slug: frontMatter.slug,
                        updated_at: frontMatter.updated_at
                    };
                }
            } catch (err) {
                console.error(`Error reading file ${file.path}:`, err);
                // Continue to next file
            }
        }
        
        return latestMemo;
    }

    private async saveFlomoNoteToLocal(memo: any): Promise<void> {
        try {
            const folderPath = this.plugin.settings.flomoSyncDirectory;
            
            // Create tag-based subfolder if memo has tags
            let subfolder = "";
            if (memo.tags && memo.tags.length > 0) {
                // Use the first tag as subfolder
                subfolder = memo.tags[0];
            }
            
            const folder = subfolder ? `${folderPath}/${subfolder}` : folderPath;
            
            // Ensure the folder exists
            await this.plugin.app.vault.adapter.mkdir(folder).catch(() => {});
            
            // Generate a sanitized filename from created date and memo slug or first few content words
            const date = new Date(memo.created_at * 1000);
            const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
            const slug = memo.slug || this.getSlugFromContent(memo.content);
            const fileName = this.sanitizeFileName(`${dateStr}-${slug}`);
            
            // Check if the note already exists by memo_id to prevent duplicates
            const existingFile = await this.findExistingMemoFile(memo.memo_id);
            
            const frontMatter = {
                memo_id: memo.memo_id,
                slug: memo.slug || '',
                created_at: memo.created_at,
                updated_at: memo.updated_at,
                tags: memo.tags || [],
                last_synced: Date.now(),
                sync_status: 'synced'
            };
            
            const mdContent = this.formatNoteContent(frontMatter, memo.content);
            
            if (existingFile) {
                // Check for conflicts before updating
                const existingFrontMatter = await this.getFrontMatter(existingFile);
                
                if (this.hasConflict(existingFrontMatter, memo, existingFile)) {
                    await this.handleConflict(existingFile, memo, mdContent);
                } else {
                    // Update existing file
                    await this.plugin.app.vault.modify(existingFile, mdContent);
                    console.log(`Updated existing Flomo note: ${existingFile.path}`);
                }
            } else {
                // Create new file with unique name to avoid collisions
                const fullPath = `${folder}/${fileName}.md`;
                await this.plugin.app.vault.create(fullPath, mdContent);
                console.log(`Created new Flomo note: ${fullPath}`);
            }
        } catch (err) {
            console.error(`Error saving Flomo note:`, err);
            this.syncStatus.errors.push({
                file: '',
                error: err.message || String(err),
                timestamp: Date.now()
            });
            throw err;
        }
    }
    
    /**
     * Check if local changes conflict with remote changes
     */
    private hasConflict(localFrontMatter: any, remoteMemo: any, file: TFile): boolean {
        if (!localFrontMatter || !localFrontMatter.last_synced) return false;
        
        // Check if the local note was modified after the last sync
        const lastSyncTime = parseInt(localFrontMatter.last_synced);
        const localModTime = file.stat.mtime;
        const remoteModTime = remoteMemo.updated_at * 1000; // Convert from Unix timestamp
        
        // If local file was modified after the last sync and remote was also modified
        return localModTime > lastSyncTime && remoteModTime !== parseInt(localFrontMatter.updated_at) * 1000;
    }
    
    /**
     * Handle conflicts between local and remote changes
     */
    private async handleConflict(file: TFile, remoteMemo: any, remoteContent: string): Promise<void> {
        const conflictResolution = this.plugin.settings.conflictResolution;
        
        if (conflictResolution === 'remote') {
            // Use remote version
            await this.plugin.app.vault.modify(file, remoteContent);
            console.log(`Conflict resolved using remote version: ${file.path}`);
        } else if (conflictResolution === 'local') {
            // Keep local version, just update frontmatter
            const content = await this.plugin.app.vault.read(file);
            const localContent = this.extractContentWithoutFrontmatter(content);
            
            const frontMatter = {
                memo_id: remoteMemo.memo_id,
                slug: remoteMemo.slug || '',
                created_at: remoteMemo.created_at,
                updated_at: remoteMemo.updated_at,
                tags: remoteMemo.tags || [],
                last_synced: Date.now(),
                sync_status: 'synced',
                conflict_resolved: 'local_preferred'
            };
            
            const updatedContent = this.formatNoteContent(frontMatter, localContent);
            await this.plugin.app.vault.modify(file, updatedContent);
            console.log(`Conflict resolved keeping local content: ${file.path}`);
        } else {
            // Mark conflict for manual resolution
            const localContent = await this.plugin.app.vault.read(file);
            
            // Create conflict markers
            const conflictContent = `---
memo_id: ${remoteMemo.memo_id}
created_at: ${remoteMemo.created_at}
updated_at: ${remoteMemo.updated_at}
tags: ${JSON.stringify(remoteMemo.tags || [])}
last_synced: ${Date.now()}
sync_status: 'conflict'
---

<<<<<<< LOCAL VERSION
${this.extractContentWithoutFrontmatter(localContent)}
=======
${remoteMemo.content}
>>>>>>> REMOTE VERSION

// Please resolve this conflict manually and remove the conflict markers
`;
            await this.plugin.app.vault.modify(file, conflictContent);
            console.log(`Conflict marked for manual resolution: ${file.path}`);
            
            // Add to sync status errors to notify user
            this.syncStatus.errors.push({
                file: file.path,
                error: 'Content conflict detected - manual resolution required',
                timestamp: Date.now()
            });
            
            new Notice(`Conflict detected in note ${file.name}. Please resolve manually.`);
        }
    }
    
    /**
     * Extract content without frontmatter from a note
     */
    private extractContentWithoutFrontmatter(content: string): string {
        const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
        return match ? match[1].trim() : content.trim();
    }
    
    /**
     * Parse YAML frontmatter from file content
     */
    private parseFrontMatter(content: string): any | null {
        try {
            const match = content.match(/^---\n([\s\S]*?)\n---/);
            if (!match) return null;
            
            // Simple YAML parsing for front matter
            const frontMatter: any = {};
            const lines = match[1].split("\n");
            
            for (const line of lines) {
                if (!line.trim()) continue;
                const colonIndex = line.indexOf(':');
                if (colonIndex === -1) continue;
                
                const key = line.substring(0, colonIndex).trim();
                let value = line.substring(colonIndex + 1).trim();
                
                // Handle array values (simplified)
                if (value.startsWith('[') && value.endsWith(']')) {
                    // Convert array string to actual array
                    const arrayItems = value.substring(1, value.length - 1).split(',').map(v => v.trim());
                    frontMatter[key] = arrayItems;
                } else {
                    frontMatter[key] = value;
                }
            }
            
            return frontMatter;
        } catch (e) {
            console.error('Error parsing front matter:', e);
            return null;
        }
    }
    
    /**
     * Extract a slug from the content if not provided
     */
    private getSlugFromContent(content: string): string {
        // Get first few words of content, max 5 words
        const words = content.trim().split(/\s+/).slice(0, 5).join('-');
        return this.sanitizeFileName(words).toLowerCase();
    }

    private sanitizeFileName(name: string): string {
        // Replace invalid characters with underscores
        let sanitized = name.replace(/[*."\\/<>:|?]/g, '_');
        
        // Remove surrounding underscores (often from markdown formatting)
        sanitized = sanitized.replace(/^_+|_+$/g, '');
        
        // Also remove leading and trailing spaces and dots
        return sanitized.trim().replace(/^\.+|\.+$/g, '');
    }

    private formatNoteContent(frontMatter: any, content: string): string {
        let yaml = '---\n';
        for (const key in frontMatter) {
            const value = frontMatter[key];
            if (Array.isArray(value)) {
                yaml += `${key}:\n`;
                value.forEach((val: string) => {
                    yaml += `  - ${val}\n`;
                });
            } else if (typeof value === 'object' && value !== null) {
                yaml += `${key}:\n`;
                for (const subKey in value) {
                    yaml += `  ${subKey}: ${value[subKey]}\n`;
                }
            } else {
                yaml += `${key}: ${JSON.stringify(value)}\n`;
            }
        }
        yaml += '---\n\n';
        return yaml + content;
    }

    private getRequestParams(): Record<string, any> {
        const params: Record<string, any> = {
            api_key: "flomo_web",
            app_version: "2.0",
            tz: "8:0",
            timestamp: Math.floor(Date.now() / 1000).toString(),
            token: this.plugin.settings.flomoApiToken,
        };
        
        const paramStr = Object.keys(params)
            .sort()
            .map((key) => `${key}=${params[key]}`)
            .join("&");
            
        const sign = crypto
            .createHash("md5")
            .update(paramStr + this.salt, "utf8")
            .digest("hex");
            
        return { ...params, sign };
    }

    private async fetchWithTimeout(url: string, options: RequestInit, timeout: number = 5000): Promise<Response> {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    }

    /**
     * Create a new memo on Flomo
     */
    private async createMemoOnFlomo(content: string, frontMatter?: any): Promise<{ success: boolean; message?: string; memo_id?: string }> {
        try {
            // Create request body
            const now = Math.floor(Date.now() / 1000);
            const requestBody: Record<string, any> = {
                content: this.formatContentForFlomo(content),
                created_at: now,
                source: "obsidian",
                file_ids: [],
                tz: "8:0",
                timestamp: now,
                api_key: "flomo_web",
                app_version: "4.0",
                platform: "web",
                webp: "1"
            };
            
            // Add sign to the request
            const signParams = { ...requestBody };
            const paramStr = Object.keys(signParams)
                .sort()
                .map((key) => `${key}=${signParams[key]}`)
                .join("&");
                
            const sign = crypto
                .createHash("md5")
                .update(paramStr + this.salt, "utf8")
                .digest("hex");
                
            requestBody.sign = sign;
            
            // Send request to Flomo API
            const response = await this.fetchWithTimeout("https://flomoapp.com/api/v1/memo", {
                method: "PUT",
                headers: {
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json;charset=utf-8",
                    "Authorization": `Bearer ${this.plugin.settings.flomoApiToken}`
                },
                body: JSON.stringify(requestBody)
            }, 10000);
            
            if (!response.ok) {
                return {
                    success: false,
                    message: `API request failed: ${response.status} ${response.statusText}`
                };
            }
            
            const data = await response.json();
            
            if (data.code !== 0) {
                return {
                    success: false,
                    message: `Flomo API error: ${data.message || JSON.stringify(data)}`
                };
            }
            
            // Extract the memo ID from the response
            const memoId = data.data?.slug;
            
            return {
                success: true,
                memo_id: memoId
            };
        } catch (error) {
            console.error("Error creating memo on Flomo:", error);
            return {
                success: false,
                message: `Error creating memo: ${error.message}`
            };
        }
    }

    /**
     * Update an existing memo on Flomo
     */
    private async updateMemoOnFlomo(memoId: string, content: string, frontMatter?: any): Promise<{ success: boolean; message?: string }> {
        try {
            // Create request body similar to create but with memo_id
            const now = Math.floor(Date.now() / 1000);
            const requestBody: Record<string, any> = {
                memo_id: memoId,
                content: this.formatContentForFlomo(content),
                updated_at: now,
                source: "obsidian",
                file_ids: [],
                tz: "8:0",
                timestamp: now,
                api_key: "flomo_web",
                app_version: "4.0",
                platform: "web",
                webp: "1"
            };
            
            // Add sign to the request
            const signParams = { ...requestBody };
            const paramStr = Object.keys(signParams)
                .sort()
                .map((key) => `${key}=${signParams[key]}`)
                .join("&");
                
            const sign = crypto
                .createHash("md5")
                .update(paramStr + this.salt, "utf8")
                .digest("hex");
                
            requestBody.sign = sign;
            
            // Send request to Flomo API - for updates, we also use PUT
            const response = await this.fetchWithTimeout("https://flomoapp.com/api/v1/memo", {
                method: "PUT",
                headers: {
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json;charset=utf-8",
                    "Authorization": `Bearer ${this.plugin.settings.flomoApiToken}`
                },
                body: JSON.stringify(requestBody)
            }, 10000);
            
            if (!response.ok) {
                return {
                    success: false,
                    message: `API request failed: ${response.status} ${response.statusText}`
                };
            }
            
            const data = await response.json();
            
            if (data.code !== 0) {
                return {
                    success: false,
                    message: `Flomo API error: ${data.message || JSON.stringify(data)}`
                };
            }
            
            return {
                success: true
            };
        } catch (error) {
            console.error("Error updating memo on Flomo:", error);
            return {
                success: false,
                message: `Error updating memo: ${error.message}`
            };
        }
    }

    /**
     * Format content for Flomo API (wrap in p tags if needed)
     */
    private formatContentForFlomo(content: string): string {
        // If content doesn't start with HTML tag, wrap it in <p> tags
        const trimmedContent = content.trim();
        if (!trimmedContent.startsWith('<')) {
            return `<p>${trimmedContent}</p>`;
        }
        return trimmedContent;
    }

    // Add a helper method to determine if AI title generation should be used
    private shouldUseAiForTitleGeneration(): boolean {
        // Check if global setting is enabled
        if (this.plugin.settings.useLlmForTitles && this.plugin.settings.llmType && this.plugin.settings.llmApiKey) {
            return true;
        }
        
        // Fall back to service-specific settings
        if (this.plugin.settings.flomoLlmType && this.plugin.settings.flomoLlmApiKey) {
            return true;
        }
        
        return false;
    }
} 