/**
 * main.ts
 * Plugin principal de Obsidian para OneDrive Sync.
 */

import { Plugin, Notice, TFolder, TFile } from "obsidian";
import { OneDriveConfig, OneDriveClient, exchangeAuthCodeForTokens } from "./src/clients/onedriveClient";
import { OneDriveSettingTab } from "./src/clients/onedriveSettingsTab";

interface PluginSettings extends OneDriveConfig {
  localVaultFolder: string;        // Carpeta local donde sincronizar
  remoteBaseFolder: string;        // Carpeta remota en OneDrive
  periodicSync: boolean;           // ¿sync cada X tiempo?
  syncIntervalMinutes: number;     // Intervalo en minutos
}

const DEFAULT_SETTINGS: PluginSettings = {
  clientId: "TU-CLIENT-ID",
  authority: "https://login.microsoftonline.com/consumers",
  redirectUri: "obsidian://onedrive-auth",
  accessToken: "",
  refreshToken: "",
  accessTokenExpiresAt: 0,

  localVaultFolder: "MyLocalVault",
  remoteBaseFolder: "",
  periodicSync: false,
  syncIntervalMinutes: 5,
};

export default class OneDrivePlugin extends Plugin {
  settings: PluginSettings;
  pkceVerifier = "";

  // Status bar item
  statusBarEl: HTMLElement | null = null;

  // Interval para sync periódico
  syncIntervalId: number | null = null;

  async onload() {
    console.log("Cargando Plugin OneDrive avanzado…");
    await this.loadSettings();

    // Creamos la SettingTab
    this.addSettingTab(new OneDriveSettingTab(this.app, this));

    // Creamos un status bar item para mostrar "OneDrive: Idle" / "Syncing..."
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar("Idle");

    // Protocol handler: obsidian://onedrive-auth?code=...
    this.registerObsidianProtocolHandler("onedrive-auth", async (params) => {
      if (!params.code) {
        new Notice("No se recibió 'code' en callback.");
        return;
      }
      try {
        const result = await exchangeAuthCodeForTokens(this.settings, params.code, this.pkceVerifier);
        if ("error" in result) {
          new Notice("Error en la autenticación: " + result.error_description);
        } else {
          this.settings.accessToken = result.access_token;
          this.settings.refreshToken = result.refresh_token ?? "";
          const expiresInMs = (result.expires_in || 3600) * 1000;
          this.settings.accessTokenExpiresAt = Date.now() + expiresInMs - 120000;

          await this.saveSettings();
          new Notice("¡Autenticación con OneDrive completada!");
        }
      } catch (err) {
        console.error("Error al canjear el code:", err);
        new Notice("Error al finalizar auth. Chequea la consola.");
      }
    });

    // Comando manual "Sync Now"
    this.addCommand({
      id: "onedrive-sync-now",
      name: "OneDrive: Sync Now",
      callback: () => this.syncVault(),
    });

    // Configuramos los eventos de cambio de archivos
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        // Podrías filtrar si el file está dentro de localVaultFolder,
        // y hacer un "debounce" para no sync en cada caracter
        if (this.isAuthenticated()) {
          // Podrías realizar un setTimeout si deseas.
          this.syncVault();
        }
      })
    );

    // Sincronizar al iniciar
    if (this.isAuthenticated()) {
      this.syncVault();
    }

    // Configurar sync periódico
    this.setupPeriodicSync();
  }

  onUnload() {
    console.log("Descargando plugin OneDrive...");
    // Limpiamos el interval
    if (this.syncIntervalId) {
      window.clearInterval(this.syncIntervalId);
    }
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Indica si el plugin tiene tokens válidos.
   */
  isAuthenticated(): boolean {
    return !!this.settings.accessToken && !!this.settings.refreshToken;
  }

  /**
   * Cambia el texto del status bar item.
   */
  updateStatusBar(status: string) {
    if (this.statusBarEl) {
      this.statusBarEl.setText(`OneDrive: ${status}`);
    }
  }

  /**
   * Configura (o limpia) el interval para sync periódico, según settings.
   */
  setupPeriodicSync() {
    if (this.syncIntervalId) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }

    if (this.settings.periodicSync && this.settings.syncIntervalMinutes > 0) {
      const ms = this.settings.syncIntervalMinutes * 60 * 1000;
      this.syncIntervalId = window.setInterval(() => {
        if (this.isAuthenticated()) {
          this.syncVault();
        }
      }, ms);
      console.log(`Sync periódico configurado cada ${this.settings.syncIntervalMinutes} min.`);
    }
  }

  /**
   * Lógica principal para sincronizar el vault local con la carpeta remota.
   * Ejemplo básico: subimos todos los archivos de localVaultFolder. 
   * (No implementa "descarga" o "delta" para simplificar).
   */
  async syncVault() {
    if (!this.isAuthenticated()) {
      new Notice("No estás autenticado en OneDrive.");
      return;
    }

    try {
      this.updateStatusBar("Syncing...");
      const client = new OneDriveClient(this.settings);

      // 1. Lista archivos en la carpeta local
      const localFolderPath = this.settings.localVaultFolder;
      const localFolder = this.app.vault.getAbstractFileByPath(localFolderPath);
      if (!localFolder || !(localFolder instanceof TFolder)) {
        new Notice(`Carpeta local '${localFolderPath}' no existe en el Vault.`);
        this.updateStatusBar("Error: no local folder");
        return;
      }

      // Recorremos recursivamente esa carpeta local
      const allFiles = this.getAllFilesInFolder(localFolderPath);

      // 2. Sube cada archivo a OneDrive (sobreescribe).
      for (const file of allFiles) {
        const arrayBuf = await this.app.vault.readBinary(file);
        const relativePath = file.path.substring(localFolderPath.length + 1); 
        // Ej: si file.path = "MyLocalVault/Notas/test.md" => relativePath= "Notas/test.md"
        await client.uploadFile(relativePath, arrayBuf);
      }

      new Notice(`Sync completado. Subidos ${allFiles.length} archivos.`);
      this.updateStatusBar("Idle");
    } catch (err) {
      console.error("Error al syncVault:", err);
      this.updateStatusBar("Error");
      new Notice("Error al sincronizar con OneDrive. Ver consola.");
    }
  }

  /**
   * Devuelve todos los archivos .md (o todos) en la carpeta local.
   * Ajusta a tus preferencias (filtrar .md o subir todo).
   */
  getAllFilesInFolder(folderPath: string) {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    const result: TFile[] = [];

    const recurse = (f: TFolder) => {
      for (const child of f.children) {
        if (child instanceof TFile) {
          // Filtra si deseas .md, .pdf, etc.
          result.push(child);
        } else if (child instanceof TFolder) {
          recurse(child);
        }
      }
    };

    if (folder && folder instanceof TFolder) {
      recurse(folder);
    }
    return result;
  }
}
