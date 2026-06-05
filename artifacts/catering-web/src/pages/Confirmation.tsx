import { Layout } from "@/components/Layout";
import { Link } from "wouter";
import { CheckCircle, Instagram, Camera } from "lucide-react";
import { useInstagramHandle, useInstagramHashtags } from "@/lib/instagram";

export default function Confirmation() {
  const igHandle = useInstagramHandle();
  const hashtags = useInstagramHashtags();

  return (
    <Layout>
      <div className="min-h-[60vh] flex items-center justify-center px-4 py-12">
        <div className="max-w-md w-full space-y-4">
          <div className="bg-card p-10 rounded-3xl border border-border shadow-2xl text-center relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-2 bg-primary" />

            <div className="w-24 h-24 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-8">
              <CheckCircle className="w-12 h-12 text-primary" />
            </div>

            <h1 className="font-display font-bold text-2xl sm:text-4xl mb-4">Request Received!</h1>
            <p className="text-muted-foreground text-lg mb-8">
              Thank you for choosing dash by Hollywood East Cafe. Our event planning team will review your inquiry and reach out within 24 hours to discuss the details.
            </p>

            <Link
              href="/"
              className="block w-full py-4 bg-secondary text-foreground font-bold rounded-xl hover:bg-secondary/80 transition-colors"
            >
              Return to Home
            </Link>
          </div>

          {igHandle && (
            <div className="bg-card rounded-3xl border border-border p-8 text-center">
              <div className="w-12 h-12 bg-pink-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Instagram className="w-6 h-6 text-pink-500" />
              </div>
              <h2 className="font-display font-bold text-lg mb-2">Follow us for event inspiration!</h2>
              <p className="text-sm text-muted-foreground mb-5">
                See what we're cooking up — behind-the-scenes, real events, and seasonal specials on Instagram.
              </p>
              <a
                href={`https://instagram.com/${igHandle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-pink-500 to-orange-400 text-white font-semibold text-sm hover:opacity-90 transition-opacity"
              >
                <Instagram className="w-4 h-4" />
                Follow @{igHandle}
              </a>
            </div>
          )}

          {hashtags.length > 0 && (
            <div className="bg-card rounded-3xl border border-border p-8 text-center">
              <div className="w-12 h-12 bg-violet-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Camera className="w-6 h-6 text-violet-500" />
              </div>
              <h2 className="font-display font-bold text-lg mb-2">Share your event photos!</h2>
              <p className="text-sm text-muted-foreground mb-5">
                Snap a photo at your event and tag us — we'd love to feature it on our wall!
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {hashtags.map((tag) => (
                  <a
                    key={tag}
                    href={`https://instagram.com/explore/tags/${tag.replace(/^#/, "")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center px-4 py-2 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 font-semibold text-sm hover:bg-violet-500/20 transition-colors"
                  >
                    #{tag.replace(/^#/, "")}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
