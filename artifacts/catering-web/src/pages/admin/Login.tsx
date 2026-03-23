import { useState } from "react";
import { useLocation } from "wouter";
import { Lock, Eye, EyeOff, Loader2 } from "lucide-react";
import { getApiBaseUrl } from "@/lib/api";

const LOGO_URL = `${import.meta.env.BASE_URL}images/dash-logo.png`;

export default function AdminLogin() {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [, navigate] = useLocation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch(`${getApiBaseUrl()}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        setError("Incorrect password. Please try again.");
        setLoading(false);
        return;
      }

      const { token } = await res.json();
      localStorage.setItem("admin_token", token);
      navigate("/admin");
    } catch {
      setError("Unable to connect. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-secondary/30 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="bg-card rounded-2xl border border-border shadow-lg p-8">
          <div className="flex flex-col items-center mb-8">
            <img
              src={LOGO_URL}
              alt="dash by Hollywood East Cafe"
              className="h-20 w-20 rounded-xl object-cover mb-4"
            />
            <h1 className="font-bold text-xl text-center">Admin Portal</h1>
            <p className="text-sm text-muted-foreground mt-1 text-center">
              dash by Hollywood East Cafe
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">Password</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
                  <Lock className="w-4 h-4 text-muted-foreground" />
                </div>
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter admin password"
                  required
                  className="w-full pl-10 pr-10 py-3 border border-border rounded-xl bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute inset-y-0 right-3 flex items-center text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full py-3 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Signing in…
                </>
              ) : (
                "Sign In"
              )}
            </button>
          </form>

          <div className="mt-6 text-center">
            <a href="/" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              ← Back to website
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
