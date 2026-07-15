import { useRef } from "react";
import { Icon } from "../Icon";

export function RunAttachmentButton({
  disabled,
  onFiles,
}: {
  disabled: boolean;
  onFiles: (files: FileList) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <button
        type="button"
        className="run-attachment-button"
        title="Add files"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <Icon name="paperclip" size={14} />
        <span>Add files</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        disabled={disabled}
        aria-label="Add files"
        onChange={(event) => {
          if (event.currentTarget.files) onFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}
