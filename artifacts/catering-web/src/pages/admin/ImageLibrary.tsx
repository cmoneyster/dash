import { useState, useCallback, useRef, useEffect } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import { Upload, Trash2, Copy, Check, ImageIcon, Loader2, X, ZoomIn, Clipboard, Image, RotateCcw } from "lucide-react";
import { ImageLightbox } from "@/components/ImageLightbox";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

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
      const res = await fetch(`${BASE}/api/admin/images`, {
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
    const res = await fetch(`${BASE}/api/admin/images/upload`, {
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
    await fetch(`${BASE}/api/admin/images/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    setImages(prev => prev.filter(img => img.id !== id));
  }, []);

  return { images, loading, initialized, fetchImages, uploadImage, deleteImage };
}

function useHeroImage() {
  const [heroImageUrl, setHeroImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);

  const fetchHero = useCallback(async () => {
    try {
      const token = getAdminToken();
      const res = await fetch(`${BASE}/api/admin/event-settings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setHeroImageUrl(data.heroImageUrl ?? null);
      }
    } finally {
      setInitialized(true);
    }
  }, []);

  const patchHero = useCallback(async (url: string | null) => {
    setSaving(true);
    try {
      const token = getAdminToken();
      const res = await fetch(`${BASE}/api/admin/event-settings/hero-image`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ heroImageUrl: url }),
      });
      if (!res.ok) throw new Error("Save failed");
      setHeroImageUrl(url);
    } finally {
      setSaving(false);
    }
  }, []);

  const uploadHero = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const token = getAdminToken();
      const form = new FormData();
      form.append("image", file);
      const res = await fetch(`${BASE}/api/admin/images/upload-hero`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { servingUrl } = await res.json();
      await patchHero(servingUrl);
    } finally {
      setUploading(false);
    }
  }, [patchHero]);

  return { heroImageUrl, uploading, saving, initialized, fetchHero, uploadHero, resetHero: () => patchHero(null) };
}

function HeroImageCard() {
  const { heroImageUrl, uploading, saving, initialized, fetchHero, uploadHero, resetHero } = useHeroImage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { fetchHero(); }, [fetchHero]);

  const handleFile = async (file: File) => {
    setError(null);
    try {
      await uploadHero(file);
    } catch {
      setError("Upload failed — please try again.");
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    if (inputRef.current) inputRef.current.value = "";
  };

  const busy = uploading || saving;

  return (
    <div className="mb-10 rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            <Image className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-display font-bold text-lg leading-tight">Hero Image</h2>
            <p className="text-xs text-muted-foreground">Home page banner · 1920×1080 (16:9)</p>
          </div>
        </div>
        {heroImageUrl && (
          <button
            onClick={resetHero}
            disabled={busy}
            className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset to default
          </button>
        )}
      </div>

      <div className="p-6">
        {!initialized ? (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : heroImageUrl ? (
          <div className="flex flex-col sm:flex-row gap-6 items-start">
            <div className="w-full sm:w-64 shrink-0 rounded-xl overflow-hidden border border-border aspect-video bg-secondary">
              <img src={heroImageUrl} alt="Current hero" className="w-full h-full object-cover" />
            </div>
            <div className="flex flex-col gap-3">
              <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                ✓ Custom hero image active
              </p>
              <p className="text-sm text-muted-foreground leading-relaxed">
                This image is currently shown on the home page. Upload a new image to replace it, or reset to restore the default photo.
              </p>
              <button
                onClick={() => inputRef.current?.click()}
                disabled={busy}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-foreground text-background text-sm font-semibold hover:bg-primary hover:text-primary-foreground disabled:opacity-50 transition-colors w-fit"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {uploading ? "Uploading…" : saving ? "Saving…" : "Upload new image"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row gap-6 items-start">
            <div className="w-full sm:w-64 shrink-0 rounded-xl border-2 border-dashed border-border aspect-video bg-secondary/50 flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <ImageIcon className="w-8 h-8 opacity-30" />
              <p className="text-xs font-medium">Using default photo</p>
            </div>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground leading-relaxed">
                The home page is currently showing the built-in default photo. Upload a 16:9 landscape image to replace it — your photo will be processed at 1920×1080.
              </p>
              <button
                onClick={() => inputRef.current?.click()}
                disabled={busy}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-foreground text-background text-sm font-semibold hover:bg-primary hover:text-primary-foreground disabled:opacity-50 transition-colors w-fit"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {uploading ? "Uploading…" : saving ? "Saving…" : "Upload hero image"}
              </button>
            </div>
          </div>
        )}
        {error && <p className="mt-3 text-sm text-destructive font-medium">{error}</p>}
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleChange} />
      </div>
    </div>
  );
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
          ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40"
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
              copied ? "bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400" : "bg-secondary hover:bg-secondary/70"
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
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-600 transition-colors"
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
        <h1 className="font-display font-bold text-2xl sm:text-4xl mb-2">Image Library</h1>
        <p className="text-muted-foreground">Upload and manage photos for your menu items and site.</p>
      </div>

      <HeroImageCard />

      <div className="mb-6">
        <h2 className="font-display font-bold text-xl mb-1">Menu Images</h2>
        <p className="text-sm text-muted-foreground">All images are auto-cropped to 4:3 (800×600).</p>
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
