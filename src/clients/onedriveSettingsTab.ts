/**
 * onedriveSettingTab.ts
 * IU en la sección de "Settings" de Obsidian para configurar OneDrive.
 */

import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type OneDrivePlugin from "../../main";
import { getAuthUrlAndVerifier } from "./onedriveClient";

/**
 * Genera un pequeño SVG/HTML con el logo de Microsoft.
 * Podrías usar un <img src="..."> si prefieres.
 */
function getMicrosoftLogoHTML(): string {
  return `
    <span style="display: inline-flex; align-items: center;">
      <svg style="width: 16px; height:16px; margin-right:4px;" viewBox="0 0 23 23">
        <rect x="1" y="1" width="10" height="10" fill="#f25022" />
        <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
        <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
        <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
      </svg>
      <span>Iniciar sesión con Microsoft</span>
    </span>
  `;
}

export class OneDriveSettingTab extends PluginSettingTab {
  plugin: OneDrivePlugin;

  constructor(app: App, plugin: OneDrivePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "OneDrive Sync Settings" });

    // Carpeta local donde sincronizar (ej. user define "MyLocalVault")
    new Setting(containerEl)
      .setName("Carpeta local")
      .setDesc("Carpeta de tu vault a sincronizar. (ej. 'MyLocalFolder')")
      .addText((text) =>
        text
          .setPlaceholder("MyLocalVault")
          .setValue(this.plugin.settings.localVaultFolder)
          .onChange(async (val) => {
            this.plugin.settings.localVaultFolder = val;
            await this.plugin.saveSettings();
          })
      );

    // Carpeta remota en OneDrive
    new Setting(containerEl)
      .setName("Carpeta remota en OneDrive")
      .setDesc("Carpeta en OneDrive donde se subirá tu contenido (vacío = raíz).")
      .addText((text) =>
        text
          .setPlaceholder("MiNotas")
          .setValue(this.plugin.settings.remoteBaseFolder)
          .onChange(async (val) => {
            this.plugin.settings.remoteBaseFolder = val;
            await this.plugin.saveSettings();
          })
      );

    // Sincronización periódica
    new Setting(containerEl)
      .setName("Activar Sync periódico")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.periodicSync)
          .onChange(async (val) => {
            this.plugin.settings.periodicSync = val;
            await this.plugin.saveSettings();
            this.plugin.setupPeriodicSync(); // reconfigura el interval
          })
      );

    new Setting(containerEl)
      .setName("Intervalo de sync (minutos)")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!isNaN(num)) {
              this.plugin.settings.syncIntervalMinutes = num;
              await this.plugin.saveSettings();
              this.plugin.setupPeriodicSync();
            }
          })
      );

    // Botón "Sync Now"
    // Se muestra sólo si autenticado
    if (this.plugin.isAuthenticated()) {
      new Setting(containerEl)
        .setName("Sincronizar ahora")
        .addButton((btn) => {
          btn.setButtonText("Sync Now");
          btn.onClick(() => {
            this.plugin.syncVault();
          });
        });
    }

    // Botón Iniciar sesión (con logo MS). Sólo si NO autenticado
    if (!this.plugin.isAuthenticated()) {
      new Setting(containerEl)
        .setName("Autenticación OneDrive")
        .setDesc("Inicia sesión con tu cuenta Microsoft.")
        .addButton((btn) => {
          btn.buttonEl.innerHTML = getMicrosoftLogoHTML(); // Reemplazamos el label con SVG
          btn.onClick(async () => {
            try {
              const { authUrl, codeVerifier } = await getAuthUrlAndVerifier(this.plugin.settings);
              this.plugin.pkceVerifier = codeVerifier;
              new Notice("Abriendo navegador para autenticación...");
              window.open(authUrl, "_blank");
            } catch (err) {
              console.error("Error al iniciar login:", err);
              new Notice("Error al iniciar login. Mira la consola.");
            }
          });
        });
    }

    // Botón Desconectar, sólo si autenticado
    if (this.plugin.isAuthenticated()) {
      new Setting(containerEl)
        .setName("Desconectar cuenta")
        .setDesc("Borra los tokens almacenados.")
        .addButton((btn) => {
          btn.setButtonText("Desconectar");
          btn.onClick(async () => {
            this.plugin.settings.accessToken = "";
            this.plugin.settings.refreshToken = "";
            this.plugin.settings.accessTokenExpiresAt = 0;
            await this.plugin.saveSettings();
            new Notice("Desconectado de OneDrive.");
            this.display(); // refresca la UI
          });
        });
    }
  }
}
