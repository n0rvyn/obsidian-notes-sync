import { Notice, TFile } from 'obsidian';
import { FrontMatter, RemoteNote, SyncQueueItem, SyncStatus } from './types';
import NotesSyncPlugin from './main';
import { SyncService } from './types';
import { LuojiLabSyncService } from './LuojiLabSyncService';
import { FlomoSyncService } from './FlomoSyncService';

export class SyncManager {
    private plugin: NotesSyncPlugin;
    private syncService: SyncService;
    private autoSyncInterval: NodeJS.Timeout | null = null;

    constructor(plugin: NotesSyncPlugin) {
        this.plugin = plugin;
        this.updateSyncService();
        this.scheduleAutoSync();
    }

    // Update the sync service based on the plugin settings
    updateSyncService() {
        const serviceType = this.plugin.settings.syncService;
        console.log(`Initializing sync service: ${serviceType}`);
        
        // Clean up existing service if needed
        this.cancelAutoSync();
        
        if (serviceType === 'luojilab') {
            this.syncService = new LuojiLabSyncService(this.plugin);
        } else if (serviceType === 'flomo') {
            this.syncService = new FlomoSyncService(this.plugin);
        } else {
            console.error(`Unknown sync service type: ${serviceType}`);
            this.syncService = new LuojiLabSyncService(this.plugin); // Default
        }
        
        // Schedule auto sync with the new service
        this.scheduleAutoSync();
    }

    // Cancel any scheduled auto sync
    private cancelAutoSync() {
        if (this.autoSyncInterval) {
            clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = null;
        }
    }

    // Delegate methods to the current sync service
    public async syncFromServer(options?: { isAutoSync?: boolean, isFullSync?: boolean }): Promise<void> {
        return this.syncService.syncFromServer(options);
    }

    /**
     * Perform a full sync that ignores incremental logic and note fetch limits
     */
    public async fullSyncFromServer(): Promise<void> {
        // Temporarily store existing settings
        const originalLastSyncId = this.plugin.settings.lastSyncId;
        const originalLastSyncTime = this.plugin.settings.lastSyncTime;
        const originalFetchLimit = this.plugin.settings.noteFetchLimit;
        
        try {
            console.log("Starting full sync - retrieving all notes regardless of sync state");
            
            // Reset sync state to force a full sync
            this.plugin.settings.lastSyncId = '';
            this.plugin.settings.lastSyncTime = 0;
            
            // Set fetch limit to 0 (unlimited)
            this.plugin.settings.noteFetchLimit = 0;
            
            // Perform the sync
            await this.syncService.syncFromServer({ isFullSync: true });
            
            // Only log success if we actually reach this point
            console.log("Full sync completed successfully");
        } catch (error) {
            console.error("Full sync failed:", error);
            
            // If sync fails, restore original sync state to prevent data loss
            this.plugin.settings.lastSyncId = originalLastSyncId;
            this.plugin.settings.lastSyncTime = originalLastSyncTime;
            this.plugin.settings.noteFetchLimit = originalFetchLimit;
            
            // Re-throw the error so the UI can handle it
            throw error;
        } finally {
            // Only restore fetch limit if the sync was successful
            // (otherwise we already restored it in the catch block)
            if (!this.plugin.settings.lastSyncId && !this.plugin.settings.lastSyncTime) {
                this.plugin.settings.noteFetchLimit = originalFetchLimit;
            }
        }
    }

    public async syncToServer(): Promise<void> {
        return this.syncService.syncToServer();
    }

    public cancelSync(): void {
        this.syncService.cancelSync();
    }

    public getSyncStatus(): SyncStatus {
        return this.syncService.getSyncStatus();
    }

    public async testApiConnection(): Promise<{ success: boolean, message: string }> {
        return this.syncService.testConnection();
    }

    public clearErrors(): void {
        // Clear errors from status
        const status = this.getSyncStatus();
        status.errors = [];
        // We'd need to update the status in the service, but for simplicity's sake
        // we just clear the array here since the errors array is returned by reference
    }

    public async deleteRemoteNote(file: TFile): Promise<boolean> {
        // Read the file to get the remote ID
        try {
            const content = await this.plugin.app.vault.read(file);
            const frontMatter = this.parseYamlFrontMatter(content);
            const remoteId = frontMatter?.remote_id;
            
            if (!remoteId) {
                throw new Error("Note doesn't have a remote ID");
            }
            
            // For now, only LuojiLab supports deleting notes
            if (this.plugin.settings.syncService !== 'luojilab') {
                throw new Error("Deleting notes is not supported for this sync service");
            }
            
            // Delete the note from the server
            await this.deleteNoteFromServer(remoteId);
            return true;
        } catch (err) {
            console.error("Error deleting note:", err);
            return false;
        }
    }

    // Helper for deleting notes from LuojiLab server
    private async deleteNoteFromServer(remoteId: string): Promise<void> {
        const baseUrl = this.plugin.settings.apiBaseUrl;
        const url = `${baseUrl}/notes/${remoteId}`;
        
        const response = await this.fetchWithTimeout(url, {
            method: "DELETE",
            headers: {
                "Authorization": `Bearer ${this.plugin.settings.bearerToken}`,
                "Content-Type": "application/json",
            },
        });
        
        if (!response.ok) {
            throw new Error(`Failed to delete note: ${response.status} ${response.statusText}`);
        }
    }

    private parseYamlFrontMatter(content: string): any | null {
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
                    // Convert array string to actual array and join back with commas for string representation
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

    // Timeout handling for fetch requests
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

    private scheduleAutoSync() {
        if (this.autoSyncInterval) {
            clearInterval(this.autoSyncInterval);
        }

        if (!this.plugin.settings.autoSync || this.plugin.settings.autoSyncInterval <= 0) {
            return;
        }

        const intervalMinutes = this.plugin.settings.autoSyncInterval;
        const intervalMs = intervalMinutes * 60 * 1000;

        this.autoSyncInterval = setInterval(async () => {
            try {
                // Only run auto sync if not already syncing
                if (this.syncService && !this.syncService.getSyncStatus().inProgress) {
                    console.log(`Running auto sync (interval: ${intervalMinutes} minutes)`);
                    
                    // Log what type of sync we're doing
                    const hasLastSyncId = this.plugin.settings.lastSyncId && this.plugin.settings.lastSyncId.trim() !== '';
                    
                    if (hasLastSyncId) {
                        console.log(`Auto sync: incremental sync using ID ${this.plugin.settings.lastSyncId}`);
                    } else if (this.plugin.settings.lastSyncTime > 0) {
                        const lastSyncDate = new Date(this.plugin.settings.lastSyncTime);
                        console.log(`Auto sync: incremental sync since ${lastSyncDate.toLocaleString()}`);
                    } else {
                        console.log(`Auto sync: full sync (no previous sync found)`);
                    }
                    
                    // Pass isAutoSync: true to tell the service this is an auto sync
                    await this.syncService.syncFromServer({ isAutoSync: true });
                }
            } catch (err) {
                console.error("Auto sync error:", err);
            }
        }, intervalMs);

        console.log(`Auto sync scheduled every ${intervalMinutes} minutes`);
    }
} 