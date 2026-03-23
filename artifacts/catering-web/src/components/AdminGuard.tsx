import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { getApiBaseUrl } from "@/lib/api";

export function getAdminToken(): string | null {
  return localStorage.getItem("admin_token");
}

export function clearAdminToken(): void {
  localStorage.removeItem("admin_token");
}

export function AdminGuard({ children }: { children: React.ReactNode }) {
  const [, navigate] = useLocation();
  const [verified, setVerified] = useState<boolean | null>(null);

  useEffect(() => {
    const token = getAdminToken();
    if (!token) {
      navigate("/admin/login");
      return;
    }

    fetch(`${getApiBaseUrl()}/api/admin/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (res.ok) {
          setVerified(true);
        } else {
          clearAdminToken();
          navigate("/admin/login");
        }
      })
      .catch(() => {
        clearAdminToken();
        navigate("/admin/login");
      });
  }, [navigate]);

  if (verified === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return <>{children}</>;
}
