import { App, Modal } from 'obsidian';

export class ConfirmModal extends Modal {
    private result: boolean;
    private onConfirm: (result: boolean) => void;
    private message: string;

    constructor(app: App, message: string, onConfirm: (result: boolean) => void) {
        super(app);
        this.message = message;
        this.onConfirm = onConfirm;
        this.result = false;
    }

    onOpen() {
        const {contentEl} = this;
        
        contentEl.createEl('p', {text: this.message});
        
        const buttonContainer = contentEl.createDiv('button-container');
        
        buttonContainer.createEl('button', {text: 'Cancel'}).addEventListener('click', () => {
            this.result = false;
            this.close();
        });
        
        buttonContainer.createEl('button', {text: 'Delete', cls: 'mod-warning'}).addEventListener('click', () => {
            this.result = true;
            this.close();
        });
    }

    onClose() {
        const {contentEl} = this;
        contentEl.empty();
        this.onConfirm(this.result);
    }
} 