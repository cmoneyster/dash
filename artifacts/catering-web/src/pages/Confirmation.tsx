import { Layout } from "@/components/Layout";
import { Link } from "wouter";
import { CheckCircle } from "lucide-react";

export default function Confirmation() {
  return (
    <Layout>
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-card p-10 rounded-3xl border border-border shadow-2xl text-center relative overflow-hidden">
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
      </div>
    </Layout>
  );
}
