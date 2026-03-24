import { useState, useCallback, useRef, useEffect } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import { Upload, Trash2, Copy, Check, ImageIcon, Loader2, X, ZoomIn, Clipboard } from "lucide-react";
import { ImageLightbox } from "@/components/ImageLightbox";

interface ImageRecord {
  id: number;
  filename: string;
  objectPath: string;
  servingUrl: string;
  uploadedAt: string;
}

function useImageLibrary() {
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const fetchImages = useCallback(async () => {
    setLoading(true);
    try {
      const token = getAdminToken();
      const res = await fetch("/api/admin/images", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setImages(await res.json());
    } finally {
      setLoading(false);
      setInitialized(true);
    }
  }, []);

  const uploadImage = useCallback(async (file: File): Promise<ImageRecord | null> => {
    const token = getAdminToken();
    const form = new FormData();
    form.append("image", file);
    const res = await fetch("/api/admin/images/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) throw new Error("Upload failed");
    const image: ImageRecord = await res.json();
    setImages(prev => [image, ...prev]);
    return image;
  }, []);

  const deleteImage = useCallback(async (id: number) => {
    const token = getAdminToken();
    await fetch(`/api/admin/images/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    setImages(prev => prev.filter(img => img.id !== id));
  }, []);

  return { images, loading, initialized, fetchImages, uploadImage, deleteImage };
}

function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false);
  const [pasted, setPasted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
    if (files.length) onFiles(files);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) onFiles(files);
    if (inputRef.current) inputRef.current.value = "";
  };

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith("image/"));
      if (files.length) {
        onFiles(files);
        setPasted(true);
        setTimeout(() => setPasted(false), 2000);
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [onFiles]);

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={`cursor-pointer border-2 border-dashed rounded-2xl p-12 text-center transition-all duration-200 select-none ${
        dragging
          ? "border-primary bg-primary/5 scale-[1.01]"
          : pasted
          ? "border-emerald-500 bg-emerald-50"
          : "border-border hover:border-primary/50 hover:bg-secondary/50"
      }`}
    >
      {pasted ? (
        <Check className="w-10 h-10 mx-auto mb-3 text-emerald-600" />
      ) : (
        <Upload className={`w-10 h-10 mx-auto mb-3 transition-colors ${dragging ? "text-primary" : "text-muted-foreground"}`} />
      )}
      <p className="font-semibold text-lg">{pasted ? "Image pasted!" : "Drag & drop images here"}</p>
      <p className="text-sm text-muted-foreground mt-1">or click to browse — JPG, PNG, WebP up to 20MB</p>
      <div className="flex items-center justify-center gap-3 mt-3 flex-wrap">
        <span className="text-xs text-muted-foreground bg-secondary/80 inline-flex items-center gap-1.5 px-3 py-1 rounded-full">
          <Clipboard className="w-3 h-3" />
          Ctrl+V to paste from clipboard
        </span>
        <span className="text-xs text-muted-foreground bg-secondary/80 inline-block px-3 py-1 rounded-full">
          Auto-cropped to 4:3 (800×600)
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleChange}
      />
    </div>
  );
}

function UploadProgress({ filename, progress }: { filename: string; progress: "uploading" | "done" | "error" }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-secondary/50 rounded-xl">
      <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center shrink-0">
        {progress === "uploading" && <Loader2 className="w-5 h-5 animate-spin text-primary" />}
        {progress === "done" && <Check className="w-5 h-5 text-emerald-600" />}
        {progress === "error" && <X className="w-5 h-5 text-destructive" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{filename}</p>
        <p className="text-xs text-muted-foreground">
          {progress === "uploading" && "Processing & uploading…"}
          {progress === "done" && "Done"}
          {progress === "error" && "Upload failed"}
        </p>
      </div>
    </div>
  );
}

function ImageCard({ image, onDelete, onCopy, onPreview, copied }: {
  image: ImageRecord;
  onDelete: () => void;
  onCopy: () => void;
  onPreview: () => void;
  copied: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="group relative bg-card border border-border rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-all duration-200">
      <div
        className="aspect-[4/3] bg-secondary overflow-hidden relative cursor-zoom-in"
        onClick={onPreview}
      >
        <img
          src={image.servingUrl}
          alt={image.filename}
          className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
          <ZoomIn className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-lg" />
        </div>
      </div>
      <div className="p-3">
        <p className="text-xs font-medium truncate text-foreground" title={image.filename}>
          {image.filename}
        </p>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          {new Date(image.uploadedAt).toLocaleDateString()}
        </p>
        <div className="flex gap-2 mt-2">
          <button
            onClick={onCopy}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              copied ? "bg-emerald-100 text-emerald-700" : "bg-secondary hover:bg-secondary/70"
            }`}
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? "Copied!" : "Copy URL"}
          </button>
          {confirmDelete ? (
            <button
              onClick={onDelete}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-destructive text-destructive-foreground"
            >
              Confirm
            </button>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              onBlur={() => setTimeout(() => setConfirmDelete(false), 200)}
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ImageLibrary() {
  const { images, loading, initialized, fetchImages, uploadImage, deleteImage } = useImageLibrary();
  const [uploads, setUploads] = useState<Record<string, "uploading" | "done" | "error">>({});
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const handleLoad = () => {
    if (!initialized) fetchImages();
  };

  const handleFiles = async (files: File[]) => {
    for (const file of files) {
      const key = `${file.name}-${Date.now()}`;
      setUploads(prev => ({ ...prev, [key]: "uploading" }));
      try {
        await uploadImage(file);
        setUploads(prev => ({ ...prev, [key]: "done" }));
        setTimeout(() => setUploads(prev => { const next = { ...prev }; delete next[key]; return next; }), 2500);
      } catch {
        setUploads(prev => ({ ...prev, [key]: "error" }));
        setTimeout(() => setUploads(prev => { const next = { ...prev }; delete next[key]; return next; }), 4000);
      }
    }
  };

  const handleCopy = (image: ImageRecord) => {
    const url = `${window.location.origin}${image.servingUrl}`;
    navigator.clipboard.writeText(url);
    setCopiedId(image.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const uploadEntries = Object.entries(uploads);
  const hasUploads = uploadEntries.length > 0;

  return (
    <AdminLayout>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      <div ref={el => { if (el && !initialized) handleLoad(); }} className="mb-8">
        <h1 className="font-display font-bold text-4xl mb-2">Image Library</h1>
        <p className="text-muted-foreground">Upload photos for your menu items. All images are auto-cropped to 4:3 (800×600).</p>
      </div>

      <DropZone onFiles={handleFiles} />

      {hasUploads && (
        <div className="mt-4 space-y-2">
          {uploadEntries.map(([key, progress]) => (
            <UploadProgress key={key} filename={key.split("-").slice(0, -1).join("-")} progress={progress} />
          ))}
        </div>
      )}

      <div className="mt-8">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : images.length === 0 ? (
          <div className="text-center py-20 text-muted-foreground">
            <ImageIcon className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="font-semibold">No images yet</p>
            <p className="text-sm mt-1">Drag and drop your first image above</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {images.map(image => (
              <ImageCard
                key={image.id}
                image={image}
                onDelete={() => deleteImage(image.id)}
                onCopy={() => handleCopy(image)}
                onPreview={() => setLightboxSrc(image.servingUrl)}
                copied={copiedId === image.id}
              />
            ))}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}

export { useImageLibrary };
