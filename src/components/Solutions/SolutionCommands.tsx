import React, { Dispatch, SetStateAction } from "react"
import { useToast } from "../../contexts/toast"
import { COMMAND_KEY } from "../../utils/platform"

export interface SolutionCommandsProps {
  solution: string
  screenshotPaths: string[]
  setView: Dispatch<SetStateAction<"queue" | "solutions" | "debug">>
}

const SolutionCommands: React.FC<SolutionCommandsProps> = ({
  solution,
  screenshotPaths,
  setView,
}) => {
  const { showToast } = useToast()

  const handleDebug = () => {
    // In the new flow, we go to the debug view, where we can take more screenshots.
    // The actual "get-debug-solution" IPC call will be triggered from the Debug view.
    setView("debug")
  }

  const handleReset = async () => {
    try {
      await window.electronAPI.resetQueues()
      setView("queue")
    } catch (error) {
      console.error("Error resetting queues:", error)
      showToast("Error", "Failed to reset", "error")
    }
  }

  return (
    <div>
      <div className="pt-2 w-fit">
        <div className="text-xs text-white/90 backdrop-blur-md bg-black/60 rounded-lg py-2 px-4 flex items-center justify-center gap-4">
          {/* Debug Command */}
          <div
            className="flex items-center gap-2 cursor-pointer rounded px-2 py-1.5 hover:bg-white/10 transition-colors"
            onClick={handleDebug}
          >
            <span className="text-[11px] leading-none">Debug</span>
            <div className="flex gap-1">
              <button className="bg-white/10 rounded-md px-1.5 py-1 text-[11px] leading-none text-white/70">
                {COMMAND_KEY}
              </button>
              <button className="bg-white/10 rounded-md px-1.5 py-1 text-[11px] leading-none text-white/70">
                D
              </button>
            </div>
          </div>

          {/* Start Over */}
          <div
            className="flex items-center gap-2 cursor-pointer rounded px-2 py-1.5 hover:bg-white/10 transition-colors"
            onClick={handleReset}
          >
            <span className="text-[11px] leading-none">Start Over</span>
            <div className="flex gap-1">
              <button className="bg-white/10 rounded-md px-1.5 py-1 text-[11px] leading-none text-white/70">
                {COMMAND_KEY}
              </button>
              <button className="bg-white/10 rounded-md px-1.5 py-1 text-[11px] leading-none text-white/70">
                R
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default SolutionCommands
