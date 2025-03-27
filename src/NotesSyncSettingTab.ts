import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import NotesSyncPlugin from './main';
import { LlmConfiguration } from './types';
import { LlmConfigModal } from './LlmConfigModal';
import { v4 as uuidv4 } from 'uuid';

export class NotesSyncSettingTab extends PluginSettingTab {
    plugin: NotesSyncPlugin;

    constructor(app: App, plugin: NotesSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        // Sync Service Selection
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
                    this.plugin.syncManager.updateSyncService();
                    this.display();
                }));

        // Common Settings Section
        this.renderCommonSettings(containerEl);

        // LLM Settings Section
        this.renderLlmSettings(containerEl);

        // Service-specific Settings
        if (this.plugin.settings.syncService === 'luojilab') {
            this.renderLuojiLabSettings(containerEl);
        } else if (this.plugin.settings.syncService === 'flomo') {
            this.renderFlomoSettings(containerEl);
        }

        // API Test Connection
        this.renderApiTestConnection(containerEl);

        // Sync Status
        this.renderSyncStatus(containerEl);
    }

    private renderCommonSettings(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "Common Settings" });
        
        // Auto Sync Settings
        new Setting(containerEl)
            .setName("Auto Sync (Both Directions)")
            .setDesc("Automatically sync notes in both directions at regular intervals")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName("Auto Pull (Server → Local)")
            .setDesc("Automatically download notes from server to local vault")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoPull)
                .onChange(async (value) => {
                    this.plugin.settings.autoPull = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Auto Push (Local → Server)")
            .setDesc("Automatically upload notes from local vault to server")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoPush)
                .onChange(async (value) => {
                    this.plugin.settings.autoPush = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Auto Sync Interval")
            .setDesc("How often to perform automatic sync operations (in minutes)")
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

        // Conflict Resolution
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
        
        // Duplicate Note Handling
        new Setting(containerEl)
            .setName("Duplicate Note Handling")
            .setDesc("How to handle notes with the same remote ID")
            .addDropdown(dropdown => dropdown
                .addOption("rename", "Rename (create new files with ID suffix)")
                .addOption("overwrite", "Overwrite (always use remote content)")
                .addOption("ignore", "Ignore (never update existing notes)")
                .setValue(this.plugin.settings.duplicateHandling)
                .onChange(async (value: "rename" | "overwrite" | "ignore") => {
                    this.plugin.settings.duplicateHandling = value;
                    await this.plugin.saveSettings();
                }));
        
        // Retry Attempts
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
    }

    private renderLlmSettings(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "LLM Settings for Title Generation" });
        
        new Setting(containerEl)
            .setName("Use LLM for Title Generation")
            .setDesc("Generate titles for notes using a Language Model")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useLlmForTitles)
                .onChange(async (value) => {
                    this.plugin.settings.useLlmForTitles = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));
        
        if (this.plugin.settings.useLlmForTitles) {
            // LLM Configurations Section
            const configSection = containerEl.createDiv("llm-configurations");
            configSection.createEl("h4", { text: "LLM Configurations" });
            
            // Display existing configurations
            this.renderLlmConfigurations(configSection);
            
            // Add new configuration button
            const addConfigContainer = configSection.createDiv('setting-item');
            new ButtonComponent(addConfigContainer)
                .setButtonText('Add New Configuration')
                .onClick(() => {
                    const newConfig: LlmConfiguration = {
                        id: uuidv4(),
                        name: '',
                        type: '' as LlmConfiguration['type'],
                        model: '',
                        apiKey: ''
                    };
                    
                    new LlmConfigModal(
                        this.app,
                        this.plugin,
                        newConfig,
                        (config: LlmConfiguration) => {
                            this.plugin.settings.llmConfigurations.push(config);
                            if (this.plugin.settings.llmConfigurations.length === 1) {
                                this.plugin.settings.activeLlmConfigId = config.id;
                            }
                            this.plugin.saveSettings();
                            this.display();
                        }
                    ).open();
                });
        }
    }

    private renderLlmConfigurations(containerEl: HTMLElement): void {
        const configList = containerEl.createDiv("llm-config-list");
        
        if (this.plugin.settings.llmConfigurations?.length > 0) {
            const configsTable = configList.createEl("table", { cls: "llm-configs-table" });
            const tableHead = configsTable.createEl("thead");
            const headerRow = tableHead.createEl("tr");
            headerRow.createEl("th", { text: "Active" });
            headerRow.createEl("th", { text: "Name" });
            headerRow.createEl("th", { text: "Type" });
            headerRow.createEl("th", { text: "Model" });
            headerRow.createEl("th", { text: "Actions" });
            
            const tableBody = configsTable.createEl("tbody");
            
            for (const config of this.plugin.settings.llmConfigurations) {
                this.renderLlmConfigRow(tableBody, config);
            }
        } else {
            configList.createEl("p", { 
                text: "No LLM configurations defined yet. Add one below.",
                cls: "llm-config-empty"
            });
        }
    }

    private renderLlmConfigRow(tableBody: HTMLElement, config: LlmConfiguration): void {
        const row = tableBody.createEl("tr");
        
        // Active radio button
        const activeCell = row.createEl("td");
        const radioLabel = activeCell.createEl("label", { cls: "llm-config-radio" });
        const radio = radioLabel.createEl("input", { 
            attr: { 
                type: "radio",
                name: "active-llm-config",
                value: config.id
            }
        }) as HTMLInputElement;
        radio.checked = config.id === this.plugin.settings.activeLlmConfigId;
        radio.addEventListener("change", async () => {
            if (radio.checked) {
                this.plugin.settings.activeLlmConfigId = config.id;
                await this.plugin.saveSettings();
            }
        });
        
        // Name cell
        row.createEl("td", { text: config.name });
        
        // Type cell
        row.createEl("td", { text: config.type || "None" });
        
        // Model cell
        row.createEl("td", { text: config.model || "-" });
        
        // Actions cell
        const actionsCell = row.createEl("td");
        
        // Edit button
        const editBtn = actionsCell.createEl("button", { 
            text: "Edit",
            cls: "llm-config-btn" 
        });
        editBtn.addEventListener("click", () => {
            const editedConfig: LlmConfiguration = {
                id: config.id,
                name: config.name,
                type: config.type,
                model: config.model,
                apiKey: config.apiKey
            };
            
            new LlmConfigModal(
                this.app,
                this.plugin,
                editedConfig,
                (updatedConfig: LlmConfiguration) => {
                    const configIndex = this.plugin.settings.llmConfigurations.findIndex(
                        c => c.id === config.id
                    );
                    
                    if (configIndex !== -1) {
                        this.plugin.settings.llmConfigurations[configIndex] = updatedConfig;
                        this.plugin.saveSettings();
                        this.display();
                    }
                }
            ).open();
        });
        
        // Delete button
        const deleteBtn = actionsCell.createEl("button", { 
            text: "Delete",
            cls: "llm-config-btn" 
        });
        deleteBtn.addEventListener("click", async () => {
            const confirmDelete = await new Promise<boolean>(resolve => {
                const modal = new ConfirmModal(
                    this.app,
                    `Are you sure you want to delete the "${config.name}" configuration?`,
                    (confirmed) => resolve(confirmed)
                );
                modal.open();
            });
            
            if (confirmDelete) {
                this.plugin.settings.llmConfigurations = this.plugin.settings.llmConfigurations.filter(
                    c => c.id !== config.id
                );
                
                if (this.plugin.settings.activeLlmConfigId === config.id) {
                    this.plugin.settings.activeLlmConfigId = '';
                }
                
                await this.plugin.saveSettings();
                this.display();
            }
        });
    }

    private renderLuojiLabSettings(containerEl: HTMLElement): void {
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
                    this.plugin.settings.apiBaseUrl = value.replace(/\/$/, '');
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
    }

    private renderFlomoSettings(containerEl: HTMLElement): void {
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
    }

    private renderApiTestConnection(containerEl: HTMLElement): void {
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
    }

    private renderSyncStatus(containerEl: HTMLElement): void {
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