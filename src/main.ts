import { App, Notice, Plugin, TFile, WorkspaceLeaf, Modal } from "obsidian";
import { NotesSyncView, VIEW_TYPE_NOTES_SYNC } from "./ChatView";
import { FrontMatter, NotesSyncSettings, RemoteNote } from "./types";
import "./styles.css";
import { SyncManager } from './SyncManager';
import * as yaml from 'js-yaml';
import { ConfirmModal } from './ConfirmModal';
import { NotesSyncSettingTab } from './NotesSyncSettingTab';

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
    private autoSyncInterval: number | null = null;
    private autoPullInterval: number | null = null;
    private autoPushInterval: number | null = null;
    private statusBar: HTMLElement | null = null;
    private statusBarInterval: number | null = null;
    settingTab: NotesSyncSettingTab;

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
        this.settingTab = new NotesSyncSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);

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