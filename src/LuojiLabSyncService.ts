import { Notice, TFile } from 'obsidian';
import { FrontMatter, RemoteNote, SyncService, SyncStatus } from './types';
import NotesSyncPlugin from './main';
import * as yaml from 'js-yaml';
import { LLMHelper } from './LLMHelper';
import * as path from 'path';

export class LuojiLabSyncService implements SyncService {
    private plugin: NotesSyncPlugin;
    private syncStatus: SyncStatus;
    private isSyncing: boolean;
    private cancelRequested: boolean;
    private llmHelper: LLMHelper;

    constructor(plugin: NotesSyncPlugin) {
        this.plugin = plugin;
        this.isSyncing = false;
        this.cancelRequested = false;
        this.llmHelper = new LLMHelper(plugin);
        this.syncStatus = {
            inProgress: false,
            lastSync: this.plugin.settings.lastSyncTime || 0,
            lastSyncId: this.plugin.settings.lastSyncId || '',
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
        if (this.isSyncing) {
            new Notice('Sync already in progress');
            return;
        }

        if (!this.plugin.settings.bearerToken) {
            new Notice('Bearer token not set. Please configure in settings.');
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

        const isAutoSync = options?.isAutoSync || false;
        const isFullSync = options?.isFullSync || false;

        // Initialize or get existing processed notes set to avoid duplicates
        // This set keeps track of note IDs that have been processed in this sync session
        let processedNoteIds = new Set<string>();
        
        try {
            // Ensure sync folder exists
            await this.ensureSyncFolderExists();
            
            // Fetch notes from server
            this.syncStatus.progress.currentFile = 'Fetching notes from server...';
            new Notice('Starting sync from server...');
            
            let notes: RemoteNote[];
            const hasLastSyncId = this.plugin.settings.lastSyncId && this.plugin.settings.lastSyncId.trim() !== '';
            const useIncrementalSync = this.plugin.settings.lastSyncTime > 0;
            
            if (isFullSync) {
                // For full sync, don't use any limits or filtering
                console.log("Performing full sync: fetching all notes without limits");
                notes = await this.fetchAllNotes();
            } else if (hasLastSyncId) {
                // ID-based incremental sync - most reliable, fetch notes newer than the last synced ID
                // For auto sync or incremental sync, don't use limit to ensure we get all new notes
                const limit = (isAutoSync || useIncrementalSync) ? 0 : this.plugin.settings.noteFetchLimit;
                
                // Get pagination info for logging purposes
                const paginatedResult = await this.fetchRemoteNotesWithPagination(limit, undefined, this.plugin.settings.lastSyncId);
                notes = paginatedResult.notes;
                console.log(`Fetching notes with ID newer than ${this.plugin.settings.lastSyncId} (has_more: ${paginatedResult.hasMore})`);
            } else if (useIncrementalSync) {
                // Time-based incremental sync - fallback if no lastSyncId is available
                // For auto sync or incremental sync, don't use limit to ensure we get all new notes
                const limit = isAutoSync ? 0 : this.plugin.settings.noteFetchLimit;
                
                // Get pagination info for logging purposes
                const paginatedResult = await this.fetchRemoteNotesWithPagination(limit, this.plugin.settings.lastSyncTime);
                notes = paginatedResult.notes;
                console.log(`Fetching notes modified since ${new Date(this.plugin.settings.lastSyncTime).toLocaleString()} (has_more: ${paginatedResult.hasMore})`);
            } else if (this.plugin.settings.noteFetchLimit > 0) {
                // For initial sync or when limit is set
                // Get pagination info for logging purposes
                const paginatedResult = await this.fetchRemoteNotesWithPagination(this.plugin.settings.noteFetchLimit);
                notes = paginatedResult.notes;
                console.log(`Fetching limited notes (limit: ${this.plugin.settings.noteFetchLimit}, has_more: ${paginatedResult.hasMore})`);
            } else {
                // For initial full sync with no limit
                notes = await this.fetchAllNotes();
            }
            
            // Check if cancelled
            if (this.cancelRequested) {
                new Notice('Sync cancelled');
                return;
            }

            this.syncStatus.progress.total = notes.length;
            new Notice(`Fetched ${notes.length} notes from server.`);

            if (notes.length === 0) {
                new Notice('No new notes to sync from server.');
            } else {
                // Store the ID of the most recent note for next sync as soon as possible
                // This helps ensure we don't re-sync the same notes if the sync is interrupted
                if (notes.length > 0 && notes[0].id) {
                    // Store the ID of the most recent note for next sync
                    this.plugin.settings.lastSyncId = notes[0].id;
                    await this.plugin.saveSettings();
                    console.log(`Updated lastSyncId to ${notes[0].id}`);
                }

                // Process notes
                if (notes.length > 0) {
                    this.syncStatus.progress.total = notes.length;
                    
                    // Use current time as the lastSyncTime
                    this.plugin.settings.lastSyncTime = Date.now();
                    
                    let successCount = 0;
                    let errorCount = 0;
                    let skipCount = 0;
                    
                    // Process each note - continue even if individual notes fail
                    for (let i = 0; i < notes.length; i++) {
                        if (this.cancelRequested) {
                            console.log('Sync cancelled while processing notes');
                            break;
                        }
                        
                        const note = notes[i];
                        
                        // Skip if we've already processed this note ID
                        if (processedNoteIds.has(note.id)) {
                            console.log(`Skipping duplicate note ID: ${note.id}`);
                            skipCount++;
                            continue;
                        }
                        
                        // Mark this note as processed
                        processedNoteIds.add(note.id);
                        
                        this.syncStatus.progress.completed = i;
                        this.syncStatus.progress.currentFile = `Processing note ${i + 1}/${notes.length}: ${note.title || 'Untitled'}`;
                        
                        try {
                            await this.createOrUpdateLocalNote(note);
                            successCount++;
                        } catch (error) {
                            errorCount++;
                            console.log(`Error creating/updating note for remote ID ${note.id}: ${error.message}`);
                            
                            // Add to errors but don't abort the sync
                            this.syncStatus.errors.push({
                                file: note.title || `Note ID: ${note.id}`,
                                error: `Failed to save note: ${error.message}`,
                                timestamp: Date.now()
                            });
                            
                            // Don't throw, continue with the next note
                        }
                    }
                    
                    // Save last sync time and settings
                    this.plugin.saveSettings();
                    
                    // Complete the sync with a summary
                    this.syncStatus.progress.completed = notes.length;
                    const summary = `Completed: ${successCount} notes saved, ${skipCount} skipped, ${errorCount} errors`;
                    this.syncStatus.progress.currentFile = summary;
                    new Notice(`Sync completed: ${successCount} notes saved, ${skipCount} skipped, ${errorCount} errors`);
                } else {
                    new Notice('No new notes to sync');
                }
            }
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

        if (!this.plugin.settings.bearerToken) {
            new Notice('Bearer token not set. Please configure in settings.');
            return;
        }

        this.isSyncing = true;
        this.cancelRequested = false;
        this.syncStatus.inProgress = true;
        this.syncStatus.progress = {
            total: 0,
            completed: 0,
            currentFile: 'Preparing to sync to server...'
        };

        try {
            const syncFolder = this.plugin.settings.syncFolder;
            if (!syncFolder) {
                throw new Error('Sync folder not set');
            }

            // Get all markdown files in the sync folder
            const files = await this.getNotesInSyncFolder(syncFolder);
            
            this.syncStatus.progress.total = files.length;
            new Notice(`Found ${files.length} local notes to check for sync.`);

            // Process each file
            for (let i = 0; i < files.length && !this.cancelRequested; i++) {
                const file = files[i];
                this.syncStatus.progress.currentFile = file.basename;
                this.syncStatus.progress.completed = i;
                
                // Read file content
                const content = await this.plugin.app.vault.read(file);
                const frontMatter = this.parseFrontMatter(content);
                const noteContent = this.extractNoteContent(content);
                
                // Skip files that have already been synced and haven't changed
                if (frontMatter?.remote_id) {
                    // This is an existing note, determine if it needs updating
                    // Logic for determining if note needs updating could be added here
                    await this.updateNoteOnServer(frontMatter, noteContent);
                } else {
                    // This is a new note to sync
                    await this.createNoteOnServer(frontMatter, noteContent);
                }
            }

            new Notice('Sync to server completed!');
        } catch (err) {
            console.error("Sync to server error:", err);
            this.syncStatus.errors.push({
                file: '',
                error: err.message || String(err),
                timestamp: Date.now()
            });
            new Notice(`Sync to server error: ${err.message}`);
        } finally {
            this.isSyncing = false;
            this.syncStatus.inProgress = false;
        }
    }

    public cancelSync(): void {
        if (!this.isSyncing) return;
        
        this.cancelRequested = true;
        new Notice('Cancelling sync operation...');
    }

    public getSyncStatus(): SyncStatus {
        return { ...this.syncStatus };
    }

    public async testConnection(): Promise<{ success: boolean; message: string }> {
        try {
            const token = this.plugin.settings.bearerToken;
            const baseUrl = this.plugin.settings.apiBaseUrl;
            
            if (!token || token.trim() === '') {
                return { 
                    success: false, 
                    message: 'No bearer token provided. Please set your token in the plugin settings.' 
                };
            }
            
            if (!baseUrl || baseUrl.trim() === '') {
                return { 
                    success: false, 
                    message: 'No API base URL provided. Please set the API base URL in the plugin settings.' 
                };
            }
            
            // Try to fetch 1 note to test the connection
            const url = new URL(`${baseUrl}/notes`);
            url.searchParams.set("sort", "create_desc");
            url.searchParams.set("limit", "1");
            
            const response = await this.fetchWithTimeout(url.toString(), {
                method: "GET",
                headers: {
                    "Accept": "application/json, text/plain, */*",
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
            });
            
            if (!response.ok) {
                return {
                    success: false,
                    message: `API request failed: ${response.status} ${response.statusText}`
                };
            }
            
            const data = await response.json();
            
            // Check if the response format is as expected
            if (!data.c || !Array.isArray(data.c.list)) {
                return {
                    success: false,
                    message: `API response format not recognized. Please check your API base URL.`
                };
            }
            
            return {
                success: true,
                message: `Connection successful! Your account is working properly.`
            };
        } catch (error) {
            if (error.name === 'AbortError') {
                return {
                    success: false,
                    message: `Connection timed out. Please check your network and API base URL.`
                };
            }
            
            return {
                success: false,
                message: `Connection error: ${error.message}`
            };
        }
    }

    private async fetchWithTimeout(url: string, options: RequestInit, timeout = 10000): Promise<Response> {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(id);
            return response;
        } catch (error) {
            clearTimeout(id);
            if (error.name === 'AbortError') {
                throw new Error('Request timed out');
            }
            throw error;
        }
    }

    private async ensureSyncFolderExists(): Promise<void> {
        const folderPath = this.plugin.settings.syncFolder;
        if (!folderPath) return;
        
        try {
            const folderExists = await this.plugin.app.vault.adapter.exists(folderPath);
            if (!folderExists) {
                await this.plugin.app.vault.createFolder(folderPath);
                new Notice(`Created sync folder: ${folderPath}`);
            }
        } catch (err) {
            console.error("Error ensuring sync folder exists:", err);
            throw new Error(`Failed to create sync folder: ${err.message}`);
        }
    }
    
    private async fetchRemoteNotes(limit?: number, sinceTimestamp?: number, sinceId?: string): Promise<RemoteNote[]> {
        // Maintain backward compatibility by using the new method but just returning the notes
        const result = await this.fetchRemoteNotesWithPagination(limit, sinceTimestamp, sinceId);
        return result.notes;
    }

    /**
     * Fetches notes from the remote API with pagination information
     * @returns Both the notes array and pagination information
     */
    private async fetchRemoteNotesWithPagination(limit?: number, sinceTimestamp?: number, sinceId?: string): Promise<{notes: RemoteNote[], hasMore: boolean}> {
        try {
            const API_TIMEOUT = 30000; // 30 seconds
            const timeout = new Promise<Response>((_, reject) => {
                setTimeout(() => reject(new Error('Request timed out')), API_TIMEOUT);
            });

            // Build query parameters
            const params = new URLSearchParams();
            
            if (limit && limit > 0) {
                params.append('limit', limit.toString());
            }
            
            if (sinceId && sinceId.trim() !== '') {
                console.log(`Using since_id parameter: ${sinceId}`);
                params.append('since_id', sinceId);
            } else if (sinceTimestamp && sinceTimestamp > 0) {
                const date = new Date(sinceTimestamp);
                const isoDate = date.toISOString();
                console.log(`Using updated_after parameter: ${isoDate}`);
                params.append('updated_after', isoDate);
            }
            
            // Always sort by creation date descending to get newest notes first
            params.append('sort', 'create_desc');
            
            // Create URL with parameters
            const url = `${this.plugin.settings.apiBaseUrl}/notes?${params.toString()}`;
            console.log(`Fetching notes with URL: ${url}`);

            const response: Response = await Promise.race([
                fetch(url, {
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.plugin.settings.bearerToken}`
                    }
                }),
                timeout
            ]);
            
            if (!response.ok) {
                throw new Error(`API request failed: ${response.status} ${response.statusText}`);
            }
            
            const data = await response.json();
            return {
                notes: data.c?.list || [],
                hasMore: data.c?.has_more || false
            };
        } catch (err) {
            console.error("Sync error:", err);
            this.syncStatus.errors.push({
                file: '',
                error: err.message || String(err),
                timestamp: Date.now()
            });
            throw new Error(`Failed to fetch notes: ${err.message}`);
        }
    }

    private async fetchAllNotes(): Promise<RemoteNote[]> {
        let allNotes: RemoteNote[] = [];
        let page = 1;
        const pageSize = 20;
        let hasMore = true;
        let maxPages = 500; // Increase from 100 to 500 to support more notes
        let lastId = ''; // Track the last ID we've seen for cursor-based pagination

        try {
            console.log(`Starting to fetch all notes with proper pagination`);
            
            // For the first page, make a clean request without filtering
            // The API expects: limit=X&sort=create_desc format
            const firstPageUrl = `${this.plugin.settings.apiBaseUrl}/notes?limit=${pageSize}&sort=create_desc`;
            console.log(`Fetching first page, URL: ${firstPageUrl}`);

            const firstPageResponse = await fetch(firstPageUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.plugin.settings.bearerToken}`
                }
            });
            
            if (!firstPageResponse.ok) {
                throw new Error(`API request failed on first page: ${firstPageResponse.status} ${firstPageResponse.statusText}`);
            }
            
            const firstPageData = await firstPageResponse.json();
            const firstBatch = firstPageData.c?.list || [];
            
            if (firstBatch.length === 0) {
                console.log('No notes found');
                return [];
            }
            
            allNotes = firstBatch;
            hasMore = firstPageData.c?.has_more || false;
            
            // Update lastId for pagination if we have notes
            if (firstBatch.length > 0) {
                lastId = firstBatch[firstBatch.length - 1].id;
                console.log(`First page fetched, last ID: ${lastId}`);
            }
            
            page++;
            
            // For subsequent pages, use cursor-based pagination with since_id parameter
            // The API expects: limit=X&since_id=LAST_ID&sort=create_desc format
            while (hasMore && page <= maxPages) {
                if (this.cancelRequested) {
                    console.log('Sync cancelled during note fetching');
                    break;
                }

                console.log(`Fetching page ${page} of notes (${allNotes.length} notes fetched so far)`);
                
                if (!lastId) {
                    console.log('No last ID available for pagination, stopping fetch');
                    break;
                }
                
                // This matches the format seen in the curl command that works
                const nextPageUrl = `${this.plugin.settings.apiBaseUrl}/notes?limit=${pageSize}&since_id=${lastId}&sort=create_desc`;
                console.log(`Fetching page ${page}, URL: ${nextPageUrl}`);
                
                const response = await fetch(nextPageUrl, {
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.plugin.settings.bearerToken}`
                    }
                });
                
                if (!response.ok) {
                    throw new Error(`API request failed on page ${page}: ${response.status} ${response.statusText}`);
                }
                
                const data = await response.json();
                const batch = data.c?.list || [];
                
                if (batch.length === 0) {
                    console.log('No more notes returned, stopping fetch');
                    break;
                }
                
                allNotes = allNotes.concat(batch);
                
                // Update hasMore flag from the API response
                hasMore = data.c?.has_more || false;
                
                // Update lastId for the next pagination request if we have notes
                if (batch.length > 0) {
                    lastId = batch[batch.length - 1].id;
                    console.log(`Last note ID for page ${page}: ${lastId}`);
                }
                
                if (hasMore) {
                    console.log(`More notes available, continuing to page ${page + 1}`);
                } else {
                    console.log(`No more notes available, stopping at page ${page}`);
                }
                
                page++;
            }

            if (page > maxPages) {
                console.log(`Reached maximum page limit (${maxPages}), stopping fetch`);
            }

            console.log(`Fetched ${allNotes.length} notes in total from ${page - 1} pages`);
            return allNotes;
        } catch (error) {
            console.error("Error fetching all notes:", error);
            throw error;
        }
    }

    private async createOrUpdateLocalNote(remoteMemo: RemoteNote): Promise<void> {
        try {
            // Skip processing if the note has no content
            if (!remoteMemo.content && !remoteMemo.title) {
                console.log(`Skipping empty note with ID ${remoteMemo.id}`);
                return;
            }

            // Determine folder path with subfolder based on tags
            const baseFolderPath = this.plugin.settings.syncFolder;
            let subfolder = "";
            if (remoteMemo.tags && remoteMemo.tags.length > 0) {
                subfolder = remoteMemo.tags[0].name;
            }
            const folderPath = subfolder ? `${baseFolderPath}/${subfolder}` : baseFolderPath;
            
            // Ensure folder exists
            await this.plugin.app.vault.createFolder(folderPath).catch(() => {
                // Folder might already exist, that's okay
            });

            // Try to find an existing file for this memo
            const existingFile = await this.findExistingNoteByRemoteId(remoteMemo.id);
            
            if (existingFile) {
                // Update existing file logic
                console.log(`Updating existing note: ${existingFile.path} (remote ID: ${remoteMemo.id})`);
                
                // Prepare the content with frontmatter
                const localContent = this.formatNoteContent(remoteMemo);
                
                if (await this.hasConflict(remoteMemo, existingFile)) {
                    // Handle conflict
                    console.log(`Conflict detected for note ${remoteMemo.id}`);
                    const conflictContent = this.formatConflictContent(remoteMemo, existingFile);
                    await this.plugin.app.vault.modify(existingFile, conflictContent);
                } else {
                    // No conflict, just update
                    await this.plugin.app.vault.modify(existingFile, localContent);
                }
                return;
            } 
            
            // No existing file found, create a new one
            // Try first without ID prefix for backward compatibility
            let fileName = this.getFileName(remoteMemo, false);
            
            // Check for any file with matching name (regardless of ID)
            const potentialExistingPath = `${folderPath}/${fileName}`;
            const fileWithSameName = await this.plugin.app.vault.getAbstractFileByPath(potentialExistingPath);
            
            // If name conflict exists, retry with ID prefix
            if (fileWithSameName) {
                console.log(`Name conflict: ${fileName} already exists, adding ID prefix`);
                // Add ID prefix to ensure uniqueness
                fileName = this.getFileName(remoteMemo, true);
                
                // If still conflicts, add timestamp as last resort
                const newPath = `${folderPath}/${fileName}`;
                const stillConflicts = await this.plugin.app.vault.getAbstractFileByPath(newPath);
                
                if (stillConflicts) {
                    console.log(`Name still conflicts even with ID prefix, adding timestamp`);
                    const fileNameParts = path.parse(fileName);
                    fileName = `${fileNameParts.name}-${Date.now()}${fileNameParts.ext}`;
                }
            }
            
            // Prepare the content with frontmatter
            const localContent = this.formatNoteContent(remoteMemo);
            
            // Create the file with a unique name
            try {
                const filePath = `${folderPath}/${fileName}`;
                await this.plugin.app.vault.create(filePath, localContent);
                console.log(`Created new note: ${filePath} (remote ID: ${remoteMemo.id})`);
                
                // Update the ID to path cache
                try {
                    const cachedData = await this.plugin.loadData() || {};
                    cachedData.idToPathCache = cachedData.idToPathCache || {};
                    cachedData.idToPathCache[remoteMemo.id] = filePath;
                    await this.plugin.saveData(cachedData);
                } catch (e) {
                    console.error('Failed to update cache after creating note:', e);
                }
            } catch (error) {
                console.error(`Failed to create note: ${error.message}`);
                throw new Error(`Failed to create note: ${error.message}`);
            }
        } catch (error) {
            console.error(`Failed to create/update note ${remoteMemo.id}: ${error.message}`);
            throw new Error(`Failed to save note: ${error.message}`);
        }
    }

    /**
     * Find a note by its remote_id in frontmatter
     */
    private async findExistingNoteByRemoteId(remoteId: string): Promise<TFile | null> {
        // Use a more efficient lookup approach
        // First, check if we have a cached index of remote_id -> file path
        
        // Check if we have a cache stored in plugin data
        let idToPathCache: Record<string, string> = {};
        
        try {
            const cachedData = await this.plugin.loadData();
            idToPathCache = cachedData?.idToPathCache || {};
        } catch (e) {
            console.log('No cache found, will build cache');
            idToPathCache = {};
        }
        
        // If we have a cache entry for this ID, check if the file still exists
        if (idToPathCache[remoteId]) {
            const cachedFile = this.plugin.app.vault.getAbstractFileByPath(idToPathCache[remoteId]);
            if (cachedFile instanceof TFile) {
                // Verify the remote_id still matches (just to be safe)
                try {
                    const content = await this.plugin.app.vault.read(cachedFile);
                    const frontMatter = this.parseFrontMatter(content);
                    
                    if (frontMatter && frontMatter.remote_id === remoteId) {
                        return cachedFile;
                    }
                } catch (err) {
                    console.log(`Cached file found but error reading content: ${err.message}`);
                    // Continue with full scan
                }
            }
        }
        
        // If no valid cache entry, scan all files in the sync folder and its subdirectories
        // Get all markdown files that could contain this note - including files in tag subdirectories
        const baseFolderPath = this.plugin.settings.syncFolder;
        const files = this.plugin.app.vault.getMarkdownFiles().filter(file => 
            file.path.startsWith(baseFolderPath + '/') || file.path === baseFolderPath
        );
        
        // If no valid cache entry, scan all files
        // But also build up the cache while we're scanning
        const newCache: Record<string, string> = {...idToPathCache};
        let foundFile: TFile | null = null;
        
        for (const file of files) {
            try {
                const content = await this.plugin.app.vault.read(file);
                const frontMatter = this.parseFrontMatter(content);
                
                if (frontMatter && frontMatter.remote_id) {
                    // Update the cache entry for this file
                    newCache[frontMatter.remote_id] = file.path;
                    
                    // If this is the file we're looking for, store it
                    if (frontMatter.remote_id === remoteId) {
                        foundFile = file;
                    }
                }
            } catch (err) {
                console.error(`Error checking file ${file.path}:`, err);
                // Continue to next file
            }
        }
        
        // Save the updated cache
        try {
            const cachedData = await this.plugin.loadData() || {};
            cachedData.idToPathCache = newCache;
            await this.plugin.saveData(cachedData);
        } catch (e) {
            console.error('Failed to update cache:', e);
        }
        
        return foundFile;
    }

    private async getNotesInSyncFolder(folder: string): Promise<TFile[]> {
        try {
            const files = await this.plugin.app.vault.getMarkdownFiles();
            return files.filter(file => 
                file.path.startsWith(folder + '/') || file.path === folder
            );
        } catch (err) {
            console.error("Error getting notes in sync folder:", err);
            throw new Error(`Failed to get notes in sync folder: ${err.message}`);
        }
    }

    private parseFrontMatter(content: string): FrontMatter | null {
        try {
            const match = content.match(/^---\n([\s\S]*?)\n---/);
            if (!match) return null;

            const frontMatter = yaml.load(match[1]) as FrontMatter;
            return frontMatter;
        } catch (e) {
            console.error('Error parsing front matter:', e);
            return null;
        }
    }
    
    private extractNoteContent(content: string): string {
        const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
        if (!match) return content;
        return match[1].trim();
    }

    private serializeToMarkdown(frontMatter: FrontMatter, content: string): string {
        let yaml = `---\n`;
        for (const key in frontMatter) {
            const value = frontMatter[key];
            if (Array.isArray(value)) {
                yaml += `${key}:\n`;
                value.forEach((val: string) => {
                    yaml += `  - ${val}\n`;
                });
            } else {
                yaml += `${key}: ${value}\n`;
            }
        }
        yaml += `---\n\n`;
        return yaml + content;
    }
    
    private async createNoteOnServer(frontMatter: FrontMatter | null, content: string) {
        const baseUrl = this.plugin.settings.apiBaseUrl;
        const url = `${baseUrl}/notes`;
        
        const payload = {
            title: frontMatter?.title || "",
            content: content,
            json_content: "", // You might want to parse content into JSON format
            entry_type: frontMatter?.entry_type || "manual",
            note_type: frontMatter?.note_type || "plain_text",
            source: frontMatter?.source || "web",
            tags: frontMatter?.tags || [],
        };

        const response = await this.fetchWithTimeout(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.plugin.settings.bearerToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error(`Failed to create note: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    }

    private async updateNoteOnServer(frontMatter: FrontMatter | null, content: string) {
        // For simplicity, we're just creating a new note
        // In a real implementation, you might want to update an existing note if supported by the API
        return this.createNoteOnServer(frontMatter, content);
    }

    private shouldUseAiForTitleGeneration(): boolean {
        // Check if global setting is enabled
        if (this.plugin.settings.useLlmForTitles && this.plugin.settings.llmType && this.plugin.settings.llmApiKey) {
            return true;
        }
        
        return false;
    }

    /**
     * Sanitizes a string to make it safe for use as a filename
     * @param name The string to sanitize
     * @returns A sanitized string with invalid characters replaced with underscores
     */
    private sanitizeFileName(name: string): string {
        // Replace invalid characters with underscores
        let sanitized = name.replace(/[*."\\/<>:|?]/g, '_');
        
        // Remove surrounding underscores (often from markdown formatting)
        sanitized = sanitized.replace(/^_+|_+$/g, '');
        
        // Also remove leading and trailing spaces and dots
        sanitized = sanitized.trim().replace(/^\.+|\.+$/g, '');

        // Limit the length to avoid excessively long filenames
        // 100 characters should be plenty for most cases
        if (sanitized.length > 100) {
            sanitized = sanitized.substring(0, 100);
        }
        
        return sanitized;
    }

    private getFileName(remoteMemo: RemoteNote, addIdPrefix: boolean = false): string {
        let fileName = remoteMemo.title?.trim() || '';
        
        // We can't use AI title generation here (synchronously) because it's async
        // We'll just use the existing title or ID
        if (!fileName || fileName === 'Untitled') {
            fileName = remoteMemo.id; // Fallback to ID if no title
        }
        
        // Apply sanitization
        let sanitizedName = this.sanitizeFileName(fileName);
        
        // Ensure we have a valid name - if sanitization removed everything, use the ID
        if (!sanitizedName || sanitizedName.length === 0) {
            sanitizedName = remoteMemo.id;
        }

        // Add ID prefix only if requested (e.g., when dealing with potential duplicates)
        if (addIdPrefix) {
            // Use the first 6 characters of the ID as a prefix
            const idPrefix = remoteMemo.id.substring(0, 6);
            sanitizedName = `${sanitizedName}-${idPrefix}`;
        }
        
        return sanitizedName + ".md";
    }

    private formatNoteContent(remoteMemo: RemoteNote): string {
        const frontMatter: FrontMatter = {
            remote_id: remoteMemo.id,
            note_id: remoteMemo.note_id,
            title: remoteMemo.title || "",
            tags: remoteMemo.tags?.map(tag => tag.name) ?? [],
            source: remoteMemo.source,
            entry_type: remoteMemo.entry_type,
            note_type: remoteMemo.note_type,
            created_at: remoteMemo.created_at,
            updated_at: remoteMemo.updated_at,
            last_synced: Date.now(),
            sync_status: 'synced'
        };

        const body = remoteMemo.content || "";
        return this.serializeToMarkdown(frontMatter, body);
    }

    private formatConflictContent(remoteMemo: RemoteNote, existingFile: TFile): string {
        // Create a simpler conflict marker without trying to read the existing file
        const conflictFrontMatter: FrontMatter = {
            remote_id: remoteMemo.id,
            note_id: remoteMemo.note_id,
            title: remoteMemo.title || "",
            tags: remoteMemo.tags?.map(tag => tag.name) ?? [],
            source: remoteMemo.source,
            entry_type: remoteMemo.entry_type,
            note_type: remoteMemo.note_type,
            created_at: remoteMemo.created_at,
            updated_at: remoteMemo.updated_at,
            last_synced: Date.now(),
            sync_status: 'conflict'
        };

        const conflictBody = `Conflict detected. Please resolve manually.\n\nRemote note ID: ${remoteMemo.id}\n\n${remoteMemo.content || ""}`;
        return this.serializeToMarkdown(conflictFrontMatter, conflictBody);
    }

    private async hasConflict(remoteMemo: RemoteNote, existingFile: TFile): Promise<boolean> {
        // Read existing file content
        const existingContent = await this.plugin.app.vault.read(existingFile);
        
        // Extract frontmatter and content
        const existingFrontMatter = this.parseFrontMatter(existingContent);
        const existingBody = this.extractNoteContent(existingContent);

        // Compare with remote content
        return existingBody !== (remoteMemo.content || "");
    }
} 