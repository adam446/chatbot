import cn from "classnames";
import { LoaderIcon } from "./icons";

type ImageEditorProps = {
  title: string;
  content: string;
  isCurrentVersion: boolean;
  currentVersionIndex: number;
  status: string;
  isInline: boolean;
};

export function ImageEditor({
  title,
  content,
  status,
  isInline,
}: ImageEditorProps) {
  const hasImage = content.trim().length > 0;

  return (
    <div
      className={cn(
        "relative flex w-full flex-row items-center justify-center",
        {
          "h-[200px]": isInline,
          "h-[calc(100dvh-60px)]": !isInline,
        }
      )}
    >
      {status === "streaming" && !hasImage ? (
        <div className="flex flex-row items-center gap-4">
          {!isInline && (
            <div className="animate-spin">
              <LoaderIcon />
            </div>
          )}
          <div>Generating Image...</div>
        </div>
      ) : (
        <>
          <picture>
            <img
              alt={title}
              className={cn("h-fit w-full max-w-[800px]", {
                "p-0 md:p-20": !isInline,
              })}
              src={`data:image/png;base64,${content}`}
            />
          </picture>
          {status === "streaming" && hasImage ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/35 backdrop-blur-[1px]">
              <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/90 px-3 py-2 text-sm shadow-[var(--shadow-float)]">
                {!isInline && (
                  <div className="animate-spin">
                    <LoaderIcon />
                  </div>
                )}
                <span>Modifying image...</span>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
