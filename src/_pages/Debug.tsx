// Debug.tsx
import React, {
  useState,
  useEffect,
  SetStateAction,
  Dispatch,
} from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { dracula } from "react-syntax-highlighter/dist/esm/styles/prism";
import ScreenshotQueue from "../components/Queue/ScreenshotQueue";
import { useToast } from "../contexts/toast";
import { Screenshot } from "../types/index";
import { COMMAND_KEY } from "../utils/platform";

const CodeSection = ({
  title,
  code,
  isLoading,
}: {
  title: string;
  code: React.ReactNode;
  isLoading: boolean;
}) => {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = () => {
    if (typeof code === "string") {
      navigator.clipboard.writeText(code).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  return (
    <div className="space-y-2 relative">
      <h2 className="text-[13px] font-medium text-white tracking-wide">
        {title}
      </h2>
      <button
        onClick={copyToClipboard}
        className="absolute top-0 right-2 text-xs text-white bg-white/10 hover:bg-white/20 rounded px-2 py-1 transition"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
      {isLoading ? (
        <div className="space-y-1.5">
          <div className="mt-4 flex">
            <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
              Loading solutions...
            </p>
          </div>
        </div>
      ) : (
        <div className="w-full">
          <SyntaxHighlighter
            showLineNumbers
            language={"typescript"} // Hardcoding for now
            style={dracula}
            customStyle={{
              maxWidth: "100%",
              margin: 0,
              padding: "1rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              backgroundColor: "rgba(22, 27, 34, 0.5)",
            }}
            wrapLongLines={true}
          >
            {code as string}
          </SyntaxHighlighter>
        </div>
      )}
    </div>
  );
};

interface DebugProps {
  solution: { solution: string; debug_analysis?: string };
  originalScreenshotPaths: string[];
  setView: Dispatch<SetStateAction<"queue" | "solutions" | "debug">>;
}

const Debug: React.FC<DebugProps> = ({
  solution,
  originalScreenshotPaths,
  setView,
}) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [debugScreenshots, setDebugScreenshots] = useState<Screenshot[]>([]);
  const { showToast } = useToast();

  const fetchDebugScreenshots = async () => {
    // In the new flow, all screenshots are in one queue.
    // For debug, we might want to distinguish or just show all.
    // Let's assume for now we get all screenshots and can't distinguish.
    const allScreenshots = await window.electronAPI.getScreenshots();
    setDebugScreenshots(allScreenshots);
  };

  useEffect(() => {
    fetchDebugScreenshots();

    const cleanup = window.electronAPI.onScreenshotTaken(() => {
      fetchDebugScreenshots();
    });

    return () => cleanup();
  }, []);

  const handleDebug = () => {
    setIsProcessing(true);
    const debugScreenshotPaths = debugScreenshots
      .map((s) => s.path)
      .filter((p) => !originalScreenshotPaths.includes(p));

    window.electronAPI.getDebugSolution(
      originalScreenshotPaths,
      solution.solution,
      debugScreenshotPaths
    );
  };

  const handleDeleteScreenshot = async (index: number) => {
    const screenshotToDelete = debugScreenshots[index];
    try {
      await window.electronAPI.deleteScreenshot(screenshotToDelete.path);
      fetchDebugScreenshots(); // Refetch
    } catch (error) {
      console.error("Failed to delete screenshot", error);
      showToast("Error", "Could not delete screenshot.", "error");
    }
  };

  return (
    <div className="p-4 space-y-4">
      <CodeSection
        title="Original Solution"
        code={solution.solution}
        isLoading={false}
      />
      {solution.debug_analysis && (
        <CodeSection
          title="Debug Analysis"
          code={solution.debug_analysis}
          isLoading={false}
        />
      )}

      <h2 className="text-[13px] font-medium text-white tracking-wide">
        Add screenshots of your code or error messages
      </h2>
      <ScreenshotQueue
        screenshots={debugScreenshots}
        onDeleteScreenshot={handleDeleteScreenshot}
        isLoading={isProcessing}
      />

      <div className="flex items-center gap-4">
        <button
          onClick={handleDebug}
          disabled={isProcessing}
          className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded disabled:opacity-50"
        >
          {isProcessing ? "Debugging..." : "Get Debug Help"}
        </button>
        <button
          onClick={() => setView("queue")}
          className="bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

export default Debug;
