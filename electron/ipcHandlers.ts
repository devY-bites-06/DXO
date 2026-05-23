// ipcHandlers.ts

import { ipcMain, shell, clipboard } from "electron"
import { randomBytes } from "crypto"
import { IIpcHandlerDeps } from "./main"
import { configHelper } from "./ConfigHelper"

export function initializeIpcHandlers(deps: IIpcHandlerDeps): void {
  console.log("Initializing IPC handlers")

  // Configuration handlers
  ipcMain.handle("get-config", () => {
    return configHelper.loadConfig();
  })

  ipcMain.handle("update-config", (_event, updates) => {
    return configHelper.updateConfig(updates);
  })

  ipcMain.handle("check-api-key", () => {
    return configHelper.hasApiKey();
  })
  
  ipcMain.handle("validate-api-key", async (_event, apiKey) => {
    const result = await configHelper.testApiKey(apiKey);
    return result;
  })

  // Screenshot queue handlers
  ipcMain.handle("get-screenshot-queue", () => {
    return deps.getScreenshotQueue()
  })

  ipcMain.handle("delete-screenshot", async (_event, path: string) => {
    return deps.deleteScreenshot(path)
  })

  ipcMain.handle("get-image-preview", async (_event, path: string) => {
    return deps.getImagePreview(path)
  })

  // New solution handler
  ipcMain.handle("get-solution", async (_event, screenshotPaths: string[]) => {
    if (!configHelper.hasApiKey()) {
      deps
        .getMainWindow()
        ?.webContents.send(deps.PROCESSING_EVENTS.API_KEY_INVALID);
      return;
    }

    await deps.processingHelper?.getSolution(screenshotPaths);
  })

  // Direct CRAG text query handler
  ipcMain.handle("crag-text-query", async (_event, query: string) => {
    if (!configHelper.hasApiKey()) {
      deps
        .getMainWindow()
        ?.webContents.send(deps.PROCESSING_EVENTS.API_KEY_INVALID);
      return;
    }

    await deps.processingHelper?.getSolutionFromText(query);
  })

  // New debug solution handler
  ipcMain.handle(
    "get-debug-solution",
    async (
      _event,
      {
        screenshotPaths,
        previousSolution,
        debugScreenshotPaths,
      }: {
        screenshotPaths: string[];
        previousSolution: string;
        debugScreenshotPaths: string[];
      }
    ) => {
      if (!configHelper.hasApiKey()) {
        deps
          .getMainWindow()
          ?.webContents.send(deps.PROCESSING_EVENTS.API_KEY_INVALID);
        return;
      }

      await deps.processingHelper?.getDebugSolution(
        screenshotPaths,
        debugScreenshotPaths,
        previousSolution
      );
    }
  )

  // Screenshot management handlers
  ipcMain.handle("get-screenshots", async () => {
    try {
      const queue = deps.getScreenshotQueue()
      const previews = await Promise.all(
        queue.map(async (path) => ({
          path,
          preview: await deps.getImagePreview(path)
        }))
      )
      return previews
    } catch (error) {
      console.error("Error getting screenshots:", error)
      throw error
    }
  })

  // Screenshot trigger handlers
  ipcMain.handle("trigger-screenshot", async () => {
    const mainWindow = deps.getMainWindow()
    if (mainWindow) {
      try {
        const screenshotPath = await deps.takeScreenshot()
        const preview = await deps.getImagePreview(screenshotPath)
        mainWindow.webContents.send("screenshot-taken", {
          path: screenshotPath,
          preview
        })
        return { success: true }
      } catch (error) {
        console.error("Error triggering screenshot:", error)
        return { error: "Failed to trigger screenshot" }
      }
    }
    return { error: "No main window available" }
  })

  // Util handlers
  ipcMain.handle("openLink", (_event, url: string) => {
    try {
      shell.openExternal(url)
      return { success: true }
    } catch (error) {
      console.error(`Error opening URL ${url}:`, error)
      return { success: false, error: `Failed to open URL: ${error}` }
    }
  })

  ipcMain.handle("reset-queues", async () => {
    try {
      deps.clearQueues()
      return { success: true }
    } catch (error) {
      console.error("Error resetting queues:", error)
      return { error: "Failed to reset queues" }
    }
  })

  ipcMain.handle("cancel-ongoing-requests", () => {
    deps.processingHelper?.cancelOngoingRequests()
  })

  ipcMain.handle("set-view", (_event, view: "queue" | "solutions" | "debug") => {
    deps.setView(view);
  });

  ipcMain.handle("open-settings-portal", () => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send("show-settings-dialog");
    }
  });
}
