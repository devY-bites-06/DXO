// Solutions.tsx
import React, { useState, SetStateAction, Dispatch } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { dracula } from "react-syntax-highlighter/dist/esm/styles/prism";
import SolutionCommands from "../components/Solutions/SolutionCommands";
import { Screenshot } from "../types";

export const SolutionSection = ({
  title,
  content,
  isLoading,
}: {
  title: string;
  content: React.ReactNode;
  isLoading: boolean;
}) => {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = () => {
    if (typeof content === "string") {
      navigator.clipboard.writeText(content).then(() => {
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
      {isLoading ? (
        <div className="space-y-1.5">
          <div className="mt-4 flex">
            <p className="text-xs bg-gradient-to-r from-gray-300 via-gray-100 to-gray-300 bg-clip-text text-transparent animate-pulse">
              Loading solutions...
            </p>
          </div>
        </div>
      ) : (
        <div className="w-full relative">
          <button
            onClick={copyToClipboard}
            className="absolute top-2 right-2 text-xs text-white bg-white/10 hover:bg-white/20 rounded px-2 py-1 transition"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          <SyntaxHighlighter
            showLineNumbers
            language={"typescript"} // Hardcoding for now, will be dynamic later
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
            {content as string}
          </SyntaxHighlighter>
        </div>
      )}
    </div>
  );
};

export interface SolutionsProps {
  solution: { solution: string; crag?: any };
  screenshotPaths: string[];
  setView: Dispatch<SetStateAction<"queue" | "solutions" | "debug">>;
}
const Solutions: React.FC<SolutionsProps> = ({
  solution,
  screenshotPaths,
  setView,
}) => {
  return (
    <div className={`bg-transparent w-full`}>
      <div className="px-4 py-3">
        <div className="space-y-3">
          <SolutionSection
            title="Solution"
            content={solution.solution}
            isLoading={false}
          />

          {/* CRAG Confidence and Citations */}
          {solution.crag && (
            <div className="bg-white/[0.03] border border-white/10 rounded-lg p-3 space-y-2 backdrop-blur-md">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold text-white/60 tracking-wider uppercase">
                  Study Note Context
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] text-white/40">Relevance Confidence:</span>
                  <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full uppercase ${
                    solution.crag.confidence === "HIGH" 
                      ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" 
                      : solution.crag.confidence === "MEDIUM"
                      ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                      : "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                  }`}>
                    {solution.crag.confidence}
                  </span>
                </div>
              </div>

              {solution.crag.chunks && solution.crag.chunks.length > 0 && (
                <details className="group border-t border-white/5 pt-2">
                  <summary className="list-none flex items-center justify-between cursor-pointer text-[9px] text-white/50 hover:text-white/80 transition-colors">
                    <span>View {solution.crag.chunks.length} Cited Sources</span>
                    <span className="text-[8px] group-open:rotate-180 transition-transform">▼</span>
                  </summary>
                  <div className="mt-2 space-y-1.5 max-h-40 overflow-y-auto pr-1">
                    {solution.crag.chunks.map((chunk: any, idx: number) => (
                      <div key={chunk.id || idx} className="bg-black/30 border border-white/5 rounded p-2 space-y-1 text-[9px]">
                        <div className="flex items-center justify-between text-white/70">
                          <span className="font-semibold text-emerald-400/90 truncate max-w-[70%]">
                            {chunk.section}
                          </span>
                          <span className="text-[7px] bg-white/5 px-1 py-0.5 rounded text-white/40">
                            {chunk.sourceFile}
                          </span>
                        </div>
                        <p className="text-white/60 leading-relaxed break-words font-light">
                          {chunk.content}
                        </p>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          <SolutionCommands
            solution={solution.solution}
            screenshotPaths={screenshotPaths}
            setView={setView}
          />
        </div>
      </div>
    </div>
  );
};

export default Solutions;
