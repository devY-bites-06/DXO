import React, { useState, useEffect, SetStateAction, Dispatch } from "react"
import { useQuery } from "@tanstack/react-query"
import ScreenshotQueue from "../components/Queue/ScreenshotQueue"
import QueueCommands from "../components/Queue/QueueCommands"

import { useToast } from "../contexts/toast"
import { Screenshot } from "../types/screenshots"

async function fetchScreenshots(): Promise<Screenshot[]> {
  try {
    const existing = await window.electronAPI.getScreenshots()
    return existing
  } catch (error) {
    console.error("Error loading screenshots:", error)
    throw error
  }
}

interface QueueProps {
  setView: (view: "queue" | "solutions" | "debug") => void
  setScreenshotPaths: Dispatch<SetStateAction<string[]>>
}

const Queue: React.FC<QueueProps> = ({ setView, setScreenshotPaths }) => {
  const { showToast } = useToast()
  const [textQuery, setTextQuery] = useState("")
  const [isSearchingText, setIsSearchingText] = useState(false)

  const {
    data: screenshots = [],
    isLoading,
    refetch
  } = useQuery<Screenshot[]>({
    queryKey: ["screenshots"],
    queryFn: fetchScreenshots,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false
  })

  useEffect(() => {
    setScreenshotPaths(screenshots.map((s) => s.path))
  }, [screenshots, setScreenshotPaths])

  const handleDeleteScreenshot = async (index: number) => {
    const screenshotToDelete = screenshots[index]

    try {
      const response = await window.electronAPI.deleteScreenshot(
        screenshotToDelete.path
      )

      if (response.success) {
        refetch() // Refetch screenshots instead of managing state directly
      } else {
        console.error("Failed to delete screenshot:", response.error)
        showToast("Error", "Failed to delete the screenshot file", "error")
      }
    } catch (error) {
      console.error("Error deleting screenshot:", error)
    }
  }

  const handleTextQuerySubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!textQuery.trim() || isSearchingText) return

    setIsSearchingText(true)
    try {
      await window.electronAPI.cragTextQuery(textQuery)
      setTextQuery("")
    } catch (err) {
      console.error("Direct text search failed:", err)
      showToast("Error", "Failed to process text search query", "error")
    } finally {
      setIsSearchingText(false)
    }
  }

  useEffect(() => {
    // Set up event listeners
    const cleanupFunctions = [
      window.electronAPI.onScreenshotTaken(() => refetch()),
      window.electronAPI.onResetView(() => refetch()),
      window.electronAPI.onDeleteLastScreenshot(async () => {
        if (screenshots.length > 0) {
          await handleDeleteScreenshot(screenshots.length - 1)
        } else {
          showToast("No Screenshots", "There are no screenshots to delete", "neutral")
        }
      }),
      window.electronAPI.onProcessingNoScreenshots(() => {
        showToast("No Screenshots", "There are no screenshots to process.", "neutral")
      }),
    ]

    return () => {
      cleanupFunctions.forEach((cleanup) => cleanup())
    }
  }, [screenshots, refetch, showToast])

  return (
    <div className={`bg-transparent w-full`}>
      <div className="px-4 py-3">
        <div className="space-y-3">
          <ScreenshotQueue
            isLoading={isLoading}
            screenshots={screenshots}
            onDeleteScreenshot={handleDeleteScreenshot}
          />

          {/* Direct Technical Question Search (CRAG) */}
          <form onSubmit={handleTextQuerySubmit} className="relative mt-2">
            <input
              type="text"
              placeholder="Ask a System Design / DSA question directly..."
              value={textQuery}
              onChange={(e) => setTextQuery(e.target.value)}
              disabled={isSearchingText}
              className="w-full bg-black/60 text-white placeholder-white/40 text-[11px] border border-white/10 rounded-lg px-4 py-2.5 pr-10 focus:outline-none focus:border-emerald-500/50 backdrop-blur-md transition-all duration-300 shadow-lg"
            />
            <button
              type="submit"
              disabled={isSearchingText}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50 hover:text-emerald-400 transition-colors"
            >
              {isSearchingText ? (
                <div className="w-3.5 h-3.5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                  className="w-3.5 h-3.5"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.768 59.768 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              )}
            </button>
          </form>

          <QueueCommands
            screenshotCount={screenshots.length}
            setView={setView}
          />
        </div>
      </div>
    </div>
  )
}

export default Queue
