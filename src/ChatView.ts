import { ItemView, WorkspaceLeaf } from 'obsidian';
import NotesSyncPlugin from './main';
import { SyncStatus } from './types';
import { ConfirmModal } from './ConfirmModal';

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

        // Styles are now in styles.css, but still call this for backward compatibility
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
                // Use ConfirmModal instead of native confirm()
                const confirmMessage = "This will perform a full sync that ignores incremental sync data and fetch limits. It may take longer than a regular sync. Continue?";
                
                const modal = new ConfirmModal(this.app, confirmMessage, async (confirmed) => {
                    if (!confirmed) return;
                    
                    try {
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
                
                modal.open();
            } catch (error) {
                this.displayNotice(`Error: ${error.message}`, "error");
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
        let noticeEl = container.querySelector(".notes-sync-notice");
        
        // If notice element doesn't exist, create it
        if (!noticeEl) {
            noticeEl = container.createEl("div", { cls: "notes-sync-notice" });
        }
        
        // Clear existing content and set new text
        noticeEl.empty();
        noticeEl.createSpan({ text: message });
        
        // Set appropriate class
        noticeEl.className = `notes-sync-notice ${type}`;
    }
    
    private addStyles() {
        // This method is no longer needed - styles are now in styles.css
        // No need to add styles dynamically
    }

    async onClose() {
        // Clean up any resources if needed
    }
} 