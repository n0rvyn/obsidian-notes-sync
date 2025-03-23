import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, Modal } from "obsidian";
import { NotesSyncView, VIEW_TYPE_NOTES_SYNC } from "./ChatView";
import { FrontMatter, NotesSyncSettings, RemoteNote } from "./types";
import "./styles.css";
import { SyncManager } from './SyncManager';
import * as yaml from 'js-yaml';
import { ConfirmModal } from './ConfirmModal';

const DEFAULT_SETTINGS: NotesSyncSettings = {
    bearerToken: '',
    apiBaseUrl: 'https://api.example.com',
    syncFolder: 'notes',
    noteFetchLimit: 50,
    retryAttempts: 3,
    conflictResolution: 'ask',
    autoSync: false,
    autoSyncInterval: 30,
    lastSyncId: '',
    lastSyncTime: 0,
    syncService: 'luojilab', // Default to LuojiLab for backward compatibility
    
    // Global LLM settings
    useLlmForTitles: false,
    llmType: '',
    llmModel: '',
    llmApiKey: '',
    
    // Flomo settings
    flomoApiToken: '',
    flomoSyncDirectory: 'flomo-notes',
    flomoLlmType: '',
    flomoLlmModel: '',
    flomoLlmApiKey: '',
    flomoFetchLimit: 200,
    flomoFetchOrder: 'latest'
};

export default class NotesSyncPlugin extends Plugin {
    settings: NotesSyncSettings;
    syncManager: SyncManager;
    autoSyncInterval: number | null = null;
    statusBar: HTMLElement | null = null;
    statusBarInterval: number | null = null;

    async onload() {
        console.log("Loading NotesSyncPlugin...");
        await this.loadSettings();
        this.syncManager = new SyncManager(this);

        // Register view
        this.registerView(
            VIEW_TYPE_NOTES_SYNC,
            (leaf: WorkspaceLeaf) => new NotesSyncView(leaf, this)
        );

        // Add settings tab
        this.addSettingTab(new NotesSyncSettingTab(this.app, this));

        // Add ribbon icon
        this.addRibbonIcon("sync", "Notes Sync", () => {
            this.activateView();
        });

        // Add sync commands
        this.addCommand({
            id: "sync-notes",
            name: "Sync Notes",
            callback: async () => {
                await this.syncManager.syncFromServer();
                await this.syncManager.syncToServer();
            }
        });

        // Add cancel sync command
        this.addCommand({
            id: 'cancel-sync',
            name: 'Cancel Ongoing Sync',
            callback: () => {
                const syncStatus = this.syncManager.getSyncStatus();
                if (syncStatus.inProgress) {
                    this.syncManager.cancelSync();
                    new Notice('Sync operation cancelled');
                } else {
                    new Notice('No sync operation in progress');
                }
            }
        });

        // Add delete note command
        this.addCommand({
            id: 'delete-remote-note',
            name: 'Delete Note from Remote Server',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (!file || file.extension.toLowerCase() !== 'md') {
                    return false;
                }
                
                if (checking) {
                    return true;
                }
                
                this.confirmDeleteNote(file);
                return true;
            }
        });

        // Start auto-sync if enabled
        if (this.settings.autoSync) {
            this.startAutoSync();
        }

        // Setup status bar
        this.setupStatusBar();
    }

    async onunload() {
        console.log("Unloading NotesSyncPlugin...");
        this.stopAutoSync();
        this.clearStatusBarInterval();
        if (this.statusBar) {
            this.statusBar.remove();
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        
        // Update auto-sync based on new settings
        if (this.settings.autoSync) {
            this.startAutoSync();
        } else {
            this.stopAutoSync();
        }
    }

    async activateView() {
        const { workspace } = this.app;
        
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_NOTES_SYNC)[0];
        
        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (!rightLeaf) {
                throw new Error("Could not create view leaf");
            }
            leaf = rightLeaf;
            await leaf.setViewState({
                type: VIEW_TYPE_NOTES_SYNC,
                active: true,
            });
        }
        
        workspace.revealLeaf(leaf);
    }

    startAutoSync() {
        if (this.autoSyncInterval) {
            clearInterval(this.autoSyncInterval);
        }

        const interval = this.settings.autoSyncInterval * 60 * 1000; // Convert minutes to milliseconds
        this.autoSyncInterval = window.setInterval(async () => {
            await this.syncManager.syncFromServer();
            await this.syncManager.syncToServer();
        }, interval);
    }

    stopAutoSync() {
        if (this.autoSyncInterval) {
            clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = null;
        }
    }

    async syncFromServer() {
        // Delegate to SyncManager but maintain backward compatibility
        return this.syncManager.syncFromServer();
    }

    async syncToServer() {
        // Delegate to SyncManager but maintain backward compatibility
        return this.syncManager.syncToServer();
    }

    async fetchRemoteNotes(limit: number): Promise<RemoteNote[]> {
        const url = new URL("https://get-notes.luojilab.com/voicenotes/web/notes");
        url.searchParams.set("sort", "create_desc");
        if (limit > 0) {
            url.searchParams.set("limit", limit.toString());
        }

        const response = await fetch(url.toString(), {
            method: "GET",
            headers: {
                "Accept": "application/json, text/plain, */*",
                "Authorization": `Bearer ${this.settings.bearerToken}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch notes: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return data.c?.list || [];
    }

    async fetchAllNotes(): Promise<RemoteNote[]> {
        let allNotes: RemoteNote[] = [];
        let page = 1;
        const pageSize = 20;

        while (true) {
            const chunk = await this.fetchRemoteNotes(pageSize);
            if (chunk.length === 0) break;
            
            allNotes = allNotes.concat(chunk);
            if (chunk.length < pageSize) break;
            
            page++;
        }

        return allNotes;
    }

    async createOrUpdateLocalNote(remoteNote: RemoteNote) {
        const folderPath = this.settings.syncFolder;
        let subfolder = "";
        if (remoteNote.tags && remoteNote.tags.length > 0) {
            subfolder = remoteNote.tags[0].name;
        }
        const folder = subfolder ? `${folderPath}/${subfolder}` : folderPath;

        const fileName = (remoteNote.title?.trim() || remoteNote.id) + ".md";
        const frontMatter: FrontMatter = {
            remote_id: remoteNote.id,
            note_id: remoteNote.note_id,
            title: remoteNote.title ?? "",
            tags: remoteNote.tags?.map(tag => tag.name) ?? [],
            source: remoteNote.source,
            entry_type: remoteNote.entry_type,
            note_type: remoteNote.note_type,
            created_at: remoteNote.created_at,
        };

        const body = remoteNote.content || "";
        const mdContent = this.serializeToMarkdown(frontMatter, body);
        const fullPath = `${folder}/${fileName}`;

        const existingFile = this.app.vault.getAbstractFileByPath(fullPath);
        if (existingFile && existingFile instanceof TFile) {
            await this.app.vault.modify(existingFile, mdContent);
        } else {
            await this.app.vault.createFolder(folder).catch(() => {});
            await this.app.vault.create(fullPath, mdContent);
        }
    }

    async createNoteOnServer(frontMatter: FrontMatter | null, content: string) {
        const url = "https://get-notes.luojilab.com/voicenotes/web/notes";
        
        const payload = {
            title: frontMatter?.title || "",
            content: content,
            json_content: "", // You might want to parse content into JSON format
            entry_type: frontMatter?.entry_type || "manual",
            note_type: frontMatter?.note_type || "plain_text",
            source: frontMatter?.source || "web",
            tags: frontMatter?.tags || [],
        };

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.settings.bearerToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error(`Failed to create note: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    }

    async updateNoteOnServer(frontMatter: FrontMatter | null, content: string) {
        return this.createNoteOnServer(frontMatter, content);
    }

    parseFrontMatter(content: string): FrontMatter | null {
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

    serializeToMarkdown(frontMatter: FrontMatter, content: string): string {
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

    setupStatusBar() {
        // Add status bar item
        this.statusBar = this.addStatusBarItem();
        this.updateStatusBar();

        // Update status bar every 2 seconds
        this.statusBarInterval = window.setInterval(() => {
            this.updateStatusBar();
        }, 2000);
    }

    clearStatusBarInterval() {
        if (this.statusBarInterval) {
            clearInterval(this.statusBarInterval);
            this.statusBarInterval = null;
        }
    }

    updateStatusBar() {
        if (!this.statusBar) return;

        const status = this.syncManager.getSyncStatus();
        if (status.inProgress) {
            const progress = status.progress;
            let progressText = '';
            if (progress.total > 0) {
                const percent = Math.round((progress.completed / progress.total) * 100);
                progressText = `${percent}% (${progress.completed}/${progress.total})`;
            }
            this.statusBar.setText(`⟳ Syncing: ${progressText} ${progress.currentFile}`);
        } else if (status.lastSync > 0) {
            const lastSyncDate = new Date(status.lastSync).toLocaleTimeString();
            this.statusBar.setText(`Last synced: ${lastSyncDate}`);
        } else {
            this.statusBar.setText('Not synced yet');
        }
    }

    async confirmDeleteNote(file: TFile) {
        const modal = new ConfirmModal(
            this.app, 
            `Are you sure you want to delete "${file.basename}" from the remote server?`,
            async (confirmed: boolean) => {
                if (confirmed) {
                    const success = await this.syncManager.deleteRemoteNote(file);
                    if (success) {
                        new Notice(`Deleted "${file.basename}" from server`);
                    }
                }
            }
        );
        modal.open();
    }

    async ensureSyncFolderExists() {
        const folderPath = this.settings.syncFolder;
        if (!folderPath) return;
        
        const folderExists = await this.app.vault.adapter.exists(folderPath);
        if (!folderExists) {
            await this.app.vault.createFolder(folderPath);
            new Notice(`Created sync folder: ${folderPath}`);
        }
    }
}

class NotesSyncSettingTab extends PluginSettingTab {
    plugin: NotesSyncPlugin;

    constructor(app: App, plugin: NotesSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        new Setting(containerEl)
            .setName("Sync Service")
            .setDesc("Choose which service to sync with")
            .addDropdown(dropdown => dropdown
                .addOption("luojilab", "LuojiLab")
                .addOption("flomo", "Flomo")
                .setValue(this.plugin.settings.syncService)
                .onChange(async (value: "luojilab" | "flomo") => {
                    this.plugin.settings.syncService = value;
                    await this.plugin.saveSettings();
                    // Update the sync service
                    this.plugin.syncManager.updateSyncService();
                    // Re-render settings to show/hide service-specific settings
                    this.display();
                }));

        // Add common settings section
        containerEl.createEl("h3", { text: "Common Settings" });
        
        new Setting(containerEl)
            .setName("Auto Sync")
            .setDesc("Automatically sync notes at regular intervals")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName("Auto Sync Interval")
            .setDesc("How often to sync notes (in minutes)")
            .addText(text => text
                .setPlaceholder("30")
                .setValue(String(this.plugin.settings.autoSyncInterval))
                .onChange(async (value) => {
                    const interval = parseInt(value);
                    if (!isNaN(interval) && interval > 0) {
                        this.plugin.settings.autoSyncInterval = interval;
                        await this.plugin.saveSettings();
                    }
                }));
        
        new Setting(containerEl)
            .setName("Conflict Resolution")
            .setDesc("How to handle conflicts between local and remote notes")
            .addDropdown(dropdown => dropdown
                .addOption("ask", "Ask me")
                .addOption("local", "Keep local changes")
                .addOption("remote", "Use remote changes")
                .setValue(this.plugin.settings.conflictResolution)
                .onChange(async (value: "ask" | "local" | "remote") => {
                    this.plugin.settings.conflictResolution = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName("Retry Attempts")
            .setDesc("Number of times to retry failed sync operations")
            .addText(text => text
                .setPlaceholder("3")
                .setValue(String(this.plugin.settings.retryAttempts))
                .onChange(async (value) => {
                    const attempts = parseInt(value);
                    if (!isNaN(attempts) && attempts > 0) {
                        this.plugin.settings.retryAttempts = attempts;
                        await this.plugin.saveSettings();
                    }
                }));

        // Add a heading for LLM settings
        containerEl.createEl("h3", { text: "LLM Settings for Title Generation" });
        
        new Setting(containerEl)
            .setName("Use LLM for Title Generation")
            .setDesc("Generate titles for notes using a Language Model")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useLlmForTitles)
                .onChange(async (value) => {
                    this.plugin.settings.useLlmForTitles = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName("LLM Type")
            .setDesc("The type of LLM to use for title generation")
            .addDropdown(dropdown => dropdown
                .addOption("", "None")
                .addOption("ZhipuAI", "ZhipuAI")
                .addOption("Tongyi", "Tongyi")
                .addOption("OpenAI", "OpenAI")
                .setValue(this.plugin.settings.llmType)
                .onChange(async (value) => {
                    this.plugin.settings.llmType = value as any;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName("LLM Model")
            .setDesc("The model to use for title generation")
            .addText(text => text
                .setPlaceholder("Model name")
                .setValue(this.plugin.settings.llmModel)
                .onChange(async (value) => {
                    this.plugin.settings.llmModel = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName("LLM API Key")
            .setDesc("API key for the selected LLM service")
            .addText(text => text
                .setPlaceholder("API key")
                .setValue(this.plugin.settings.llmApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.llmApiKey = value;
                    await this.plugin.saveSettings();
                }));

        // Service-specific settings
        if (this.plugin.settings.syncService === 'luojilab') {
            // LuojiLab settings
            containerEl.createEl("h3", { text: "LuojiLab Settings" });
            
            new Setting(containerEl)
                .setName("Bearer Token")
                .setDesc("Your authentication token for the LuojiLab notes API")
                .addText(text => text
                    .setPlaceholder("Enter your token")
                    .setValue(this.plugin.settings.bearerToken)
                    .onChange(async (value) => {
                        this.plugin.settings.bearerToken = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName("API Base URL")
                .setDesc("Base URL for the LuojiLab notes API (without trailing slash)")
                .addText(text => text
                    .setPlaceholder("https://example.com/api")
                    .setValue(this.plugin.settings.apiBaseUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.apiBaseUrl = value.replace(/\/$/, ''); // Remove trailing slash if present
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName("Sync Folder")
                .setDesc("The folder where LuojiLab synced notes will be stored")
                .addText(text => text
                    .setPlaceholder("notes")
                    .setValue(this.plugin.settings.syncFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.syncFolder = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName("Note Fetch Limit")
                .setDesc("Maximum number of notes to fetch per sync (0 for no limit)")
                .addText(text => text
                    .setPlaceholder("20")
                    .setValue(String(this.plugin.settings.noteFetchLimit))
                    .onChange(async (value) => {
                        const limit = parseInt(value);
                        if (!isNaN(limit) && limit >= 0) {
                            this.plugin.settings.noteFetchLimit = limit;
                            await this.plugin.saveSettings();
                        }
                    }));
        } else if (this.plugin.settings.syncService === 'flomo') {
            // Flomo settings
            containerEl.createEl("h3", { text: "Flomo Settings" });
            
            new Setting(containerEl)
                .setName("Flomo API Token")
                .setDesc("Your authentication token for the Flomo API")
                .addText(text => text
                    .setPlaceholder("Enter your Flomo token")
                    .setValue(this.plugin.settings.flomoApiToken)
                    .onChange(async (value) => {
                        this.plugin.settings.flomoApiToken = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName("Flomo Sync Directory")
                .setDesc("The folder where Flomo synced notes will be stored")
                .addText(text => text
                    .setPlaceholder("flomo-notes")
                    .setValue(this.plugin.settings.flomoSyncDirectory)
                    .onChange(async (value) => {
                        this.plugin.settings.flomoSyncDirectory = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName("Flomo Fetch Limit")
                .setDesc("Maximum number of memos to fetch per sync")
                .addText(text => text
                    .setPlaceholder("200")
                    .setValue(String(this.plugin.settings.flomoFetchLimit))
                    .onChange(async (value) => {
                        const limit = parseInt(value);
                        if (!isNaN(limit) && limit > 0) {
                            this.plugin.settings.flomoFetchLimit = limit;
                            await this.plugin.saveSettings();
                        }
                    }));

            new Setting(containerEl)
                .setName("Flomo Fetch Order")
                .setDesc("Order in which to fetch Flomo memos")
                .addDropdown(dropdown => dropdown
                    .addOption("latest", "Latest First")
                    .addOption("oldest", "Oldest First")
                    .setValue(this.plugin.settings.flomoFetchOrder)
                    .onChange(async (value: "latest" | "oldest") => {
                        this.plugin.settings.flomoFetchOrder = value;
                        await this.plugin.saveSettings();
                    }));

            // LLM settings for Flomo
            containerEl.createEl("h4", { text: "Flomo LLM Settings (Optional)" });
            
            new Setting(containerEl)
                .setName("LLM Type")
                .setDesc("The type of language model to use for generating note titles")
                .addDropdown(dropdown => dropdown
                    .addOption("", "None")
                    .addOption("ZhipuAI", "ZhipuAI")
                    .addOption("Tongyi", "Tongyi")
                    .setValue(this.plugin.settings.flomoLlmType)
                    .onChange(async (value: "" | "ZhipuAI" | "Tongyi") => {
                        this.plugin.settings.flomoLlmType = value;
                        await this.plugin.saveSettings();
                        // Refresh to show/hide model field based on selection
                        this.display();
                    }));

            // Only show model and API key if LLM type is selected
            if (this.plugin.settings.flomoLlmType) {
                new Setting(containerEl)
                    .setName("LLM Model")
                    .setDesc("The specific model to use")
                    .addText(text => text
                        .setPlaceholder("Enter model name")
                        .setValue(this.plugin.settings.flomoLlmModel)
                        .onChange(async (value) => {
                            this.plugin.settings.flomoLlmModel = value;
                            await this.plugin.saveSettings();
                        }));

                new Setting(containerEl)
                    .setName("LLM API Key")
                    .setDesc("API key for the selected language model")
                    .addText(text => text
                        .setPlaceholder("Enter API key")
                        .setValue(this.plugin.settings.flomoLlmApiKey)
                        .onChange(async (value) => {
                            this.plugin.settings.flomoLlmApiKey = value;
                            await this.plugin.saveSettings();
                        }));
            }
        }

        // Add API test connection button for any service
        new Setting(containerEl)
            .setName("API Connection")
            .setDesc("Test your API connection")
            .addButton(button => button
                .setButtonText("Test Connection")
                .onClick(async () => {
                    button.setButtonText("Testing...");
                    button.setDisabled(true);
                    
                    try {
                        const result = await this.plugin.syncManager.testApiConnection();
                        if (result.success) {
                            new Notice(result.message);
                        } else {
                            new Notice("Connection failed: " + result.message);
                        }
                    } catch (err) {
                        new Notice("Error testing connection: " + err.message);
                    }
                    
                    button.setButtonText("Test Connection");
                    button.setDisabled(false);
                }));

        // Add status information
        const statusInfo = this.plugin.syncManager.getSyncStatus();
        const statusContainer = containerEl.createDiv('sync-status');
        statusContainer.createEl('h3', { text: 'Sync Status' });
        
        if (statusInfo.inProgress) {
            statusContainer.createEl('p', { text: 'Sync in progress...' });
        } else if (statusInfo.lastSync > 0) {
            const lastSyncDate = new Date(statusInfo.lastSync).toLocaleString();
            statusContainer.createEl('p', { text: `Last synced: ${lastSyncDate}` });
        }

        if (statusInfo.errors.length > 0) {
            const errorList = statusContainer.createEl('div', { cls: 'sync-errors' });
            errorList.createEl('h4', { text: 'Recent Errors' });
            const ul = errorList.createEl('ul');
            statusInfo.errors.slice(-5).forEach(error => {
                const li = ul.createEl('li');
                li.createEl('strong', { text: new Date(error.timestamp).toLocaleString() });
                li.createEl('span', { text: `: ${error.error} (${error.file})` });
            });

            new Setting(statusContainer)
                .addButton(button => button
                    .setButtonText('Clear Errors')
                    .onClick(() => {
                        this.plugin.syncManager.clearErrors();
                        this.display();
                    }));
        }
    }
} 