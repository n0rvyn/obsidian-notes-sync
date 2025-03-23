import { ItemView, WorkspaceLeaf } from 'obsidian';
import NotesSyncPlugin from './main';
import { SyncStatus } from './types';

export const VIEW_TYPE_NOTES_SYNC = "notes-sync-view";

export class NotesSyncView extends ItemView {
    plugin: NotesSyncPlugin;
    private activeServiceTab: 'luojilab' | 'flomo';

    constructor(leaf: WorkspaceLeaf, plugin: NotesSyncPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.activeServiceTab = this.plugin.settings.syncService;
    }

    getViewType(): string {
        return VIEW_TYPE_NOTES_SYNC;
    }

    getDisplayText(): string {
        return "Notes Sync";
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.createEl("h4", { text: "Notes Sync" });

        // Create tabs for different sync services
        const tabsContainer = container.createEl("div", { cls: "notes-sync-tabs" });
        
        // LuojiLab tab
        const luojiLabTab = tabsContainer.createEl("div", { 
            cls: `notes-sync-tab ${this.activeServiceTab === 'luojilab' ? 'active' : ''}`,
            text: "LuojiLab"
        });
        luojiLabTab.addEventListener("click", () => {
            this.activeServiceTab = 'luojilab';
            this.refreshView();
        });
        
        // Flomo tab
        const flomoTab = tabsContainer.createEl("div", { 
            cls: `notes-sync-tab ${this.activeServiceTab === 'flomo' ? 'active' : ''}`,
            text: "Flomo"
        });
        flomoTab.addEventListener("click", () => {
            this.activeServiceTab = 'flomo';
            this.refreshView();
        });

        // Content container
        const contentContainer = container.createEl("div", { cls: "notes-sync-content" });
        
        // Render the appropriate content based on active tab
        this.renderServiceContent(contentContainer);

        // Add CSS for tabs
        this.addStyles();
    }

    private refreshView() {
        // Switch the service in the plugin settings
        this.plugin.settings.syncService = this.activeServiceTab;
        this.plugin.saveSettings();
        
        // Only update if syncManager is ready
        if (this.plugin.syncManager) {
            this.plugin.syncManager.updateSyncService();
        }
        
        // Re-render the view
        this.onOpen();
    }

    private renderServiceContent(container: HTMLElement) {
        container.empty();
        
        const statusContainer = container.createEl("div", { cls: "notes-sync-status" });
        
        // Service-specific heading
        const serviceTitle = this.activeServiceTab === 'luojilab' ? 'LuojiLab Sync' : 'Flomo Sync';
        statusContainer.createEl("h5", { text: serviceTitle });
        
        // Service status - get from syncManager if available, otherwise use default values
        let syncStatus: SyncStatus;
        if (this.plugin.syncManager) {
            syncStatus = this.plugin.syncManager.getSyncStatus();
        } else {
            // Default status if syncManager not available
            syncStatus = {
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
        
        const statusEl = statusContainer.createEl("div", { cls: "sync-status-info" });
        
        if (syncStatus.inProgress) {
            statusEl.textContent = `Sync in progress: ${syncStatus.progress.completed}/${syncStatus.progress.total} - ${syncStatus.progress.currentFile}`;
        } else if (syncStatus.lastSync > 0) {
            statusEl.textContent = `Last synced: ${new Date(syncStatus.lastSync).toLocaleString()}`;
        } else {
            statusEl.textContent = 'Not synced yet';
        }
        
        // Add action buttons
        const buttonsContainer = statusContainer.createEl("div", { cls: "sync-buttons" });
        
        // Sync from server button
        const syncFromButton = buttonsContainer.createEl("button", { 
            text: this.activeServiceTab === 'luojilab' ? "Sync from LuojiLab" : "Sync from Flomo",
            cls: "sync-button"
        });
        syncFromButton.addEventListener("click", async () => {
            try {
                // Try using syncManager, fall back to plugin method if needed
                if (this.plugin.syncManager) {
                    await this.plugin.syncManager.syncFromServer();
                } else {
                    await this.plugin.syncFromServer();
                }
                
                this.displayNotice("Sync from server completed!", "success");
                this.refreshView(); // Update status after sync
            } catch (error) {
                this.displayNotice(`Sync failed: ${error.message}`, "error");
            }
        });
        
        // Add a "Full Sync" button for fetching all notes
        const fullSyncButton = buttonsContainer.createEl("button", { 
            text: "Full Sync",
            cls: "sync-button full-sync"
        });
        fullSyncButton.addEventListener("click", async () => {
            try {
                // Confirm full sync as it might take some time
                if (!confirm("This will perform a full sync that ignores incremental sync data and fetch limits. It may take longer than a regular sync. Continue?")) {
                    return;
                }
                
                // Try using syncManager, fall back to plugin method if needed
                if (this.plugin.syncManager) {
                    await this.plugin.syncManager.fullSyncFromServer();
                } else {
                    this.displayNotice("Full sync not supported in this version", "error");
                    return;
                }
                
                this.displayNotice("Full sync from server completed!", "success");
                this.refreshView(); // Update status after sync
            } catch (error) {
                this.displayNotice(`Full sync failed: ${error.message}`, "error");
            }
        });

        // Only show Sync to Server for LuojiLab (since Flomo doesn't support it)
        if (this.activeServiceTab === 'luojilab') {
            const syncToButton = buttonsContainer.createEl("button", { 
                text: "Sync to LuojiLab",
                cls: "sync-button"
            });
            syncToButton.addEventListener("click", async () => {
                try {
                    // Try using syncManager, fall back to plugin method if needed
                    if (this.plugin.syncManager) {
                        await this.plugin.syncManager.syncToServer();
                    } else {
                        await this.plugin.syncToServer();
                    }
                    
                    this.displayNotice("Sync to server completed!", "success");
                    this.refreshView(); // Update status after sync
                } catch (error) {
                    this.displayNotice(`Sync failed: ${error.message}`, "error");
                }
            });
        } else if (this.activeServiceTab === 'flomo') {
            // Now we support syncing to Flomo
            const syncToButton = buttonsContainer.createEl("button", { 
                text: "Sync to Flomo",
                cls: "sync-button"
            });
            syncToButton.addEventListener("click", async () => {
                try {
                    if (this.plugin.syncManager) {
                        await this.plugin.syncManager.syncToServer();
                    } else {
                        await this.plugin.syncToServer();
                    }
                    
                    this.displayNotice("Sync to Flomo completed!", "success");
                    this.refreshView(); // Update status after sync
                } catch (error) {
                    this.displayNotice(`Sync failed: ${error.message}`, "error");
                }
            });
        }
        
        // Cancel button (only show if sync is in progress)
        if (syncStatus.inProgress) {
            const cancelButton = buttonsContainer.createEl("button", { 
                text: "Cancel Sync",
                cls: "sync-button cancel"
            });
            cancelButton.addEventListener("click", () => {
                // Use syncManager if available
                if (this.plugin.syncManager) {
                    this.plugin.syncManager.cancelSync();
                }
                
                this.displayNotice("Cancelling sync...", "info");
                
                // Refresh view after a short delay
                setTimeout(() => this.refreshView(), 1000);
            });
        }

        // Status message area
        statusContainer.createEl("div", { 
            cls: "notes-sync-notice",
            text: "Ready to sync"
        });
        
        // Show error count if there are any
        if (syncStatus.errors && syncStatus.errors.length > 0) {
            const errorCountEl = statusContainer.createEl("div", { 
                cls: "sync-error-count",
                text: `${syncStatus.errors.length} error${syncStatus.errors.length > 1 ? 's' : ''}`
            });
            errorCountEl.addEventListener("click", () => {
                this.showErrors(syncStatus.errors);
            });
        }
    }
    
    private showErrors(errors: Array<{file: string, error: string, timestamp: number}>) {
        // Create a modal to show errors
        const container = this.containerEl.children[1];
        const errorsContainer = container.createEl("div", { cls: "sync-errors-modal" });
        
        const header = errorsContainer.createEl("div", { cls: "modal-header" });
        header.createEl("h5", { text: "Sync Errors" });
        
        const closeBtn = header.createEl("button", { text: "×", cls: "close-button" });
        closeBtn.addEventListener("click", () => {
            errorsContainer.remove();
        });
        
        const errorList = errorsContainer.createEl("ul", { cls: "error-list" });
        
        errors.forEach(error => {
            const li = errorList.createEl("li");
            li.createEl("div", { 
                cls: "error-time", 
                text: new Date(error.timestamp).toLocaleString() 
            });
            li.createEl("div", { 
                cls: "error-message", 
                text: error.error 
            });
            if (error.file) {
                li.createEl("div", { 
                    cls: "error-file", 
                    text: `File: ${error.file}` 
                });
            }
        });
        
        const clearBtn = errorsContainer.createEl("button", { 
            text: "Clear Errors", 
            cls: "sync-button" 
        });
        clearBtn.addEventListener("click", () => {
            // Use syncManager if available
            if (this.plugin.syncManager) {
                this.plugin.syncManager.clearErrors();
            }
            
            errorsContainer.remove();
            this.refreshView();
        });
    }

    private displayNotice(message: string, type: "success" | "error" | "info") {
        const container = this.containerEl.children[1];
        const noticeEl = container.querySelector(".notes-sync-notice");
        if (noticeEl) {
            noticeEl.textContent = message;
            noticeEl.className = `notes-sync-notice ${type}`;
        }
    }
    
    private addStyles() {
        // Add styles for tabs and content
        const styleEl = document.getElementById('notes-sync-styles');
        if (styleEl) styleEl.remove();
        
        const newStyle = document.createElement('style');
        newStyle.id = 'notes-sync-styles';
        newStyle.textContent = `
            .notes-sync-tabs {
                display: flex;
                border-bottom: 1px solid var(--background-modifier-border);
                margin-bottom: 1rem;
            }
            
            .notes-sync-tab {
                padding: 0.5rem 1rem;
                cursor: pointer;
                border-bottom: 2px solid transparent;
                margin-right: 0.5rem;
            }
            
            .notes-sync-tab.active {
                border-bottom: 2px solid var(--interactive-accent);
                font-weight: bold;
            }
            
            .sync-button {
                margin-right: 0.5rem;
                margin-bottom: 1rem;
            }
            
            .sync-button.cancel {
                background-color: var(--background-modifier-error);
                color: white;
            }
            
            .notes-sync-notice {
                padding: 0.5rem;
                margin-top: 1rem;
                border-radius: 4px;
            }
            
            .notes-sync-notice.success {
                background-color: var(--background-modifier-success);
                color: white;
            }
            
            .notes-sync-notice.error {
                background-color: var(--background-modifier-error);
                color: white;
            }
            
            .notes-sync-notice.info {
                background-color: var(--background-modifier-border);
            }
            
            .sync-status-info {
                margin-bottom: 1rem;
                font-style: italic;
            }
            
            .sync-error-count {
                color: var(--text-error);
                cursor: pointer;
                text-decoration: underline;
                margin-top: 0.5rem;
            }
            
            .sync-errors-modal {
                position: absolute;
                top: 2rem;
                left: 1rem;
                right: 1rem;
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                padding: 1rem;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                z-index: 100;
                max-height: 80%;
                overflow-y: auto;
            }
            
            .modal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 1rem;
                border-bottom: 1px solid var(--background-modifier-border);
                padding-bottom: 0.5rem;
            }
            
            .close-button {
                background: none;
                border: none;
                font-size: 1.5rem;
                cursor: pointer;
                padding: 0;
                line-height: 1;
            }
            
            .error-list {
                padding-left: 0;
                list-style: none;
            }
            
            .error-list li {
                margin-bottom: 1rem;
                padding-bottom: 0.5rem;
                border-bottom: 1px solid var(--background-modifier-border);
            }
            
            .error-time {
                font-size: 0.8rem;
                color: var(--text-muted);
                margin-bottom: 0.25rem;
            }
            
            .error-message {
                color: var(--text-error);
                margin-bottom: 0.25rem;
            }
            
            .error-file {
                font-size: 0.8rem;
                font-style: italic;
            }
        `;
        
        document.head.appendChild(newStyle);
    }

    async onClose() {
        // Clean up any resources if needed
        const styleEl = document.getElementById('notes-sync-styles');
        if (styleEl) styleEl.remove();
    }
} 