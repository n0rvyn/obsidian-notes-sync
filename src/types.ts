export interface RemoteNote {
    id: string;
    note_id: string;
    title: string;
    content: string;
    json_content: string;
    entry_type: string;
    note_type: string;
    source: string;
    tags: Array<{
        id: string;
        name: string;
        type: string;
        visible: boolean;
    }>;
    created_at: string;
    updated_at?: string;
}

export interface NotesSyncSettings {
    bearerToken: string;
    syncFolder: string;
    noteFetchLimit: number;
    retryAttempts: number;
    conflictResolution: 'ask' | 'local' | 'remote';
    lastSyncId: string;
    lastSyncTime: number;
    autoSync: boolean;
    autoSyncInterval: number;
    apiBaseUrl: string;
    syncService: 'luojilab' | 'flomo';
    
    // LLM settings that can be used by both services
    useLlmForTitles: boolean;
    llmType: 'ZhipuAI' | 'Tongyi' | 'OpenAI' | '';
    llmModel: string;
    llmApiKey: string;
    
    // Flomo specific settings
    flomoApiToken: string;
    flomoSyncDirectory: string;
    flomoLlmType: 'ZhipuAI' | 'Tongyi' | '';
    flomoLlmModel: string;
    flomoLlmApiKey: string;
    flomoFetchLimit: number;
    flomoFetchOrder: 'latest' | 'oldest';
}

export interface FrontMatter {
    [key: string]: any;
    remote_id?: string;
    note_id?: string;
    title?: string;
    tags?: string[];
    source?: string;
    entry_type?: string;
    note_type?: string;
    created_at?: string;
    updated_at?: string;
    last_synced?: number;      // Local timestamp of last sync
    sync_status?: 'synced' | 'pending' | 'conflict' | 'error';
}

export interface SyncStatus {
    inProgress: boolean;
    lastSync: number;
    lastSyncId: string;
    pendingChanges: number;
    errors: Array<{
        file: string;
        error: string;
        timestamp: number;
    }>;
    progress: {
        total: number;
        completed: number;
        currentFile: string;
    };
}

export interface SyncQueueItem {
    type: 'upload' | 'download';
    path: string;
    remoteId?: string;
    retryCount: number;
    timestamp: number;
}

export interface SyncService {
    syncFromServer(options?: { isAutoSync?: boolean, isFullSync?: boolean }): Promise<void>;
    syncToServer(): Promise<void>;
    testConnection(): Promise<{success: boolean, message: string}>;
    cancelSync(): void;
    getSyncStatus(): SyncStatus;
} 