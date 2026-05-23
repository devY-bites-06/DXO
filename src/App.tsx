import SubscribedApp from "./_pages/SubscribedApp"
import { UpdateNotification } from "./components/UpdateNotification"
import {
  QueryClient,
  QueryClientProvider
} from "@tanstack/react-query"
import { useEffect, useState, useCallback } from "react"
import {
  Toast,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport
} from "./components/ui/toast"
import { ToastContext } from "./contexts/toast"
import { WelcomeScreen } from "./components/WelcomeScreen"
import { SettingsDialog } from "./components/Settings/SettingsDialog"

// Create a React Query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: Infinity,
      retry: 1,
      refetchOnWindowFocus: false
    },
    mutations: {
      retry: 1
    }
  }
})

// Root component that provides the QueryClient
function App() {
  const [toastState, setToastState] = useState({
    open: false,
    title: "",
    description: "",
    variant: "neutral" as "neutral" | "success" | "error",
  })
  const [isInitialized, setIsInitialized] = useState(false)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)

  const showToast = useCallback(
    (
      title: string,
      description: string,
      variant: "neutral" | "success" | "error"
    ) => {
      setToastState({
        open: true,
        title,
        description,
        variant,
      })
    },
    []
  )

  // Check for API key and prompt if not found
  useEffect(() => {
    const checkApiKey = async () => {
      try {
        const hasKey = await window.electronAPI.checkApiKey()
        setHasApiKey(hasKey)

        if (!hasKey) {
          setTimeout(() => {
            setIsSettingsOpen(true)
          }, 1000)
        }
      } catch (error) {
        console.error("Failed to check API key:", error)
      }
    }

    if (isInitialized) {
      checkApiKey()
    }
  }, [isInitialized])

  // Listen for settings dialog open requests
  useEffect(() => {
    const unsubscribeSettings = window.electronAPI.onShowSettings(() => {
      setIsSettingsOpen(true)
    })

    return () => {
      unsubscribeSettings()
    }
  }, [])

  // Initialize basic app state
  useEffect(() => {
    const initializeApp = async () => {
      try {
        const config = await window.electronAPI.getConfig()
        setHasApiKey(!!config.apiKey)
        setIsInitialized(true)
      } catch (error) {
        console.error("Failed to initialize app:", error)
        setIsInitialized(true) // Still initialize to show welcome screen
      }
    }

    initializeApp()

    const onApiKeyInvalid = () => {
      showToast(
        "API Key Invalid",
        "Your Gemini API key appears to be invalid.",
        "error"
      )
      setIsSettingsOpen(true)
    }

    window.electronAPI.onApiKeyInvalid(onApiKeyInvalid)

    return () => {
      window.electronAPI.removeListener("API_KEY_INVALID", onApiKeyInvalid)
    }
  }, [showToast])

  const handleCloseSettings = useCallback((open: boolean) => {
    setIsSettingsOpen(open)
  }, [])

  const handleApiKeySave = useCallback(async (apiKey: string) => {
    try {
      await window.electronAPI.updateConfig({ apiKey })
      setHasApiKey(true)
      showToast("Success", "API key saved successfully", "success")

      setTimeout(() => {
        window.location.reload()
      }, 1500)
    } catch (error) {
      console.error("Failed to save API key:", error)
      showToast("Error", "Failed to save API key", "error")
    }
  }, [showToast])

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ToastContext.Provider value={{ showToast }}>
          <div className="relative">
            {isInitialized ? (
              hasApiKey ? (
                <SubscribedApp />
              ) : (
                <WelcomeScreen onOpenSettings={() => setIsSettingsOpen(true)} />
              )
            ) : (
              <div>Loading...</div>
            )}
            <UpdateNotification />
            <SettingsDialog
              open={isSettingsOpen}
              onOpenChange={handleCloseSettings}
              onApiKeySave={handleApiKeySave}
            />
          </div>

          <Toast
            variant={toastState.variant}
            open={toastState.open}
            onOpenChange={(open) => setToastState({ ...toastState, open })}
          >
            <div className="grid gap-1">
              <ToastTitle>{toastState.title}</ToastTitle>
              {toastState.description && (
                <ToastDescription>{toastState.description}</ToastDescription>
              )}
            </div>
          </Toast>
          <ToastViewport />
        </ToastContext.Provider>
      </ToastProvider>
    </QueryClientProvider>
  )
}

export default App