import { Tray, Menu, nativeImage, BrowserWindow } from 'electron';
import * as path from 'path';

export class TrayManager {
  private tray: Tray | null = null;
  private mainWindow: BrowserWindow | null = null;
  private isRecording = false;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
    this.createTray();
  }

  private createTray(): void {
    // Create tray icon (you'll need to provide an icon file)
    const icon = nativeImage.createFromPath(
      path.join(__dirname, '../assets/tray-icon.png')
    );
    this.tray = new Tray(icon);
    this.tray.setToolTip('Interview Copilot');

    this.updateMenu();
  }

  updateMenu(): void {
    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Open Control Panel',
        click: () => {
          this.mainWindow?.show();
          this.mainWindow?.focus();
        },
      },
    ];

    if (this.isRecording) {
      menuTemplate.push({
        label: '⏹ Stop Recording',
        click: () => {
          this.mainWindow?.webContents.send('stop-recording-from-tray');
        },
      });
    }

    menuTemplate.push(
      { type: 'separator' },
      { label: 'Settings', click: () => this.mainWindow?.webContents.send('open-settings') },
      { type: 'separator' },
      { label: 'Quit', click: () => require('electron').app.quit() }
    );

    this.tray?.setContextMenu(Menu.buildFromTemplate(menuTemplate));
  }

  setRecording(isRecording: boolean): void {
    this.isRecording = isRecording;
    this.updateMenu();
  }
}
