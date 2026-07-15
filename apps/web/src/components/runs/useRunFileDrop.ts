import { useEffect, useRef, useState, type DragEventHandler } from "react";

function carriesFiles(types: DataTransfer["types"]): boolean {
  return Array.from(types).includes("Files");
}

export function useRunFileDrop<T extends HTMLElement>({
  disabled,
  onFiles,
}: {
  disabled: boolean;
  onFiles: (files: FileList) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    if (!disabled) return;
    dragDepth.current = 0;
    setDragOver(false);
  }, [disabled]);

  const onDragEnter: DragEventHandler<T> = (event) => {
    if (!carriesFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    dragDepth.current += 1;
    event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (!disabled) setDragOver(true);
  };

  const onDragOver: DragEventHandler<T> = (event) => {
    if (!carriesFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = disabled ? "none" : "copy";
  };

  const onDragLeave: DragEventHandler<T> = (event) => {
    if (dragDepth.current === 0) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };

  const onDrop: DragEventHandler<T> = (event) => {
    if (!carriesFiles(event.dataTransfer.types) && event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    if (!disabled && event.dataTransfer.files.length > 0) onFiles(event.dataTransfer.files);
  };

  return {
    dragOver,
    dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
