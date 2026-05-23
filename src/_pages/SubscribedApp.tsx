// file: src/_pages/SubscribedApp.tsx
import { useEffect, useRef, useState } from "react"
import Queue from "./Queue"
import Solutions from "./Solutions"
import Debug from "./Debug"
import { useToast } from "../contexts/toast"

const SubscribedApp: React.FC = () => {
  const [view, setView] = useState<"queue" | "solutions" | "debug">("queue")
  const [solution, setSolution] = useState<any>(null)
  const [screenshotPaths, setScreenshotPaths] = useState<string[]>([])

  const { showToast } = useToast()

  useEffect(() => {
    const handleSolutionSuccess = (
      _event: any,
      data: { solution: any; screenshots: string[] }
    ) => {
      setSolution(data.solution)
      setScreenshotPaths(data.screenshots)
      setView("solutions")
    }

    const handleDebugSuccess = (_event: any, data: any) => {
      setSolution(data)
      setView("debug") // Or maybe a dedicated debug view
    }
    
    const handleInitialStart = () => {
      // You can show a loading indicator here
      setView('solutions') // Switch to a view that can show loading
    }

    const handleDebugStart = () => {
      setView('debug') // Switch to a view that can show loading
    }

    const handleError = (_event: any, error: { message: string }) => {
      showToast("Error", error.message, "error")
      setView("queue") // Go back to queue on error
    }

    const handleReset = () => {
      setView("queue")
      setSolution(null)
      setScreenshotPaths([])
    }

    window.electronAPI.onSolutionSuccess(handleSolutionSuccess)
    window.electronAPI.onDebugSuccess(handleDebugSuccess)
    window.electronAPI.onSolutionError(handleError)
    window.electronAPI.onDebugError(handleError)
    window.electronAPI.onInitialStart(handleInitialStart)
    window.electronAPI.onDebugStart(handleDebugStart)
    window.electronAPI.onResetView(handleReset)
    window.electronAPI.onQueuesCleared(handleReset)

    return () => {
      window.electronAPI.removeListener("solution-success", handleSolutionSuccess)
      window.electronAPI.removeListener("debug-success", handleDebugSuccess)
      window.electronAPI.removeListener("solution-error", handleError)
      window.electronAPI.removeListener("debug-error", handleError)
      window.electronAPI.removeListener("initial-start", handleInitialStart)
      window.electronAPI.removeListener("debug-start", handleDebugStart)
      window.electronAPI.removeListener("reset-view", handleReset)
      window.electronAPI.removeListener("queues-cleared", handleReset)
    }
  }, [showToast])

  useEffect(() => {
    window.electronAPI.setView(view);
  }, [view]);

  return (
    <div className="min-h-0">
      {view === "queue" && (
        <Queue setView={setView} setScreenshotPaths={setScreenshotPaths} />
      )}
      {view === "solutions" && solution && (
        <Solutions
          solution={solution}
          screenshotPaths={screenshotPaths}
          setView={setView}
        />
      )}
      {view === "debug" && solution && "originalSolution" in solution ? (
        <Debug
          solution={solution}
          originalScreenshotPaths={screenshotPaths}
          setView={setView}
        />
      ) : (
        view === "debug" && (
          <div className="p-4 text-white">
            <p>
              Please add new screenshots for debugging and press Ctrl+Enter.
            </p>
          </div>
        )
      )}
    </div>
  )
}

export default SubscribedApp
