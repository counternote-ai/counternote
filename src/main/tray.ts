import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron';
import * as path from 'path';

export type TrayState = 'idle' | 'recording' | 'finishing';

export class TrayManager {
  private tray: Tray | null = null;
  private mainWindow: BrowserWindow | null = null;
  private state: TrayState = 'idle';
  public onStop: (() => void) | null = null;

  constructor(
    mainWindow: BrowserWindow,
    private readonly onQuit?: () => void,
  ) {
    this.mainWindow = mainWindow;
    this.createTray();
  }

  private createTray(): void {
    // Create tray icon (you'll need to provide an icon file)
    const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/tray-icon.png'));
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

    if (this.state === 'recording') {
      menuTemplate.push({
        label: '⏹ Stop Recording',
        click: () => {
          this.onStop?.();
        },
      });
    }

    if (this.state === 'finishing') {
      menuTemplate.push({
        label: '⏹ Finishing…',
        enabled: false,
      });
    }

    menuTemplate.push(
      { type: 'separator' },
      { label: 'Settings', click: () => this.mainWindow?.webContents.send('open-settings') },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          if (this.onQuit) {
            this.onQuit();
          } else {
            app.quit();
          }
        },
      },
    );

    this.tray?.setContextMenu(Menu.buildFromTemplate(menuTemplate));
  }

  /** @deprecated Use setState instead */
  setRecording(isRecording: boolean): void {
    this.setState(isRecording ? 'recording' : 'idle');
  }

  setState(state: TrayState): void {
    this.state = state;
    this.updateMenu();
  }
}
