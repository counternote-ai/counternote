export const app = {
  whenReady: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  quit: jest.fn(),
  isPackaged: false,
  getPath: jest.fn().mockReturnValue('/tmp/interview-copilot'),
};

export const BrowserWindow = jest.fn().mockImplementation(() => ({
  loadFile: jest.fn(),
  webContents: { send: jest.fn() },
  show: jest.fn(),
  focus: jest.fn(),
}));

export const ipcMain = {
  handle: jest.fn(),
  on: jest.fn(),
};

export const ipcRenderer = {
  send: jest.fn(),
  invoke: jest.fn(),
  on: jest.fn(),
};

export const contextBridge = {
  exposeInMainWorld: jest.fn(),
};

export const session = {
  defaultSession: {
    setDisplayMediaRequestHandler: jest.fn(),
  },
};

export const desktopCapturer = {
  getSources: jest.fn().mockResolvedValue([]),
};

export const Tray = jest.fn().mockImplementation(() => ({
  setToolTip: jest.fn(),
  setContextMenu: jest.fn(),
}));

export const Menu = {
  buildFromTemplate: jest.fn().mockReturnValue({}),
};

export const nativeImage = {
  createFromPath: jest.fn().mockReturnValue({}),
};

export const safeStorage = {
  encryptStringAsync: jest.fn().mockResolvedValue(Buffer.from('encrypted')),
  decryptStringAsync: jest.fn().mockResolvedValue({ result: 'decrypted', shouldReEncrypt: false }),
};

export const systemPreferences = {
  getMediaAccessStatus: jest.fn().mockReturnValue('granted'),
};

export const shell = {
  openExternal: jest.fn().mockResolvedValue(undefined),
};
