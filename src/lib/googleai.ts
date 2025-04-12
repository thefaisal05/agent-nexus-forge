
import { GoogleGenerativeAI } from "@google/generative-ai";

// Initialize the Google AI client
// Note: You'll need to set your API key in the Supabase dashboard under "Secrets"
let googleAI: GoogleGenerativeAI | null = null;

export function initGoogleAI(apiKey: string) {
  googleAI = new GoogleGenerativeAI(apiKey);
  return googleAI;
}

export function getGoogleAI() {
  if (!googleAI) {
    throw new Error("Google AI client not initialized. Call initGoogleAI first.");
  }
  return googleAI;
}

export async function generateText(prompt: string, apiKey: string) {
  // Initialize if not already done
  if (!googleAI) {
    initGoogleAI(apiKey);
  }
  
  try {
    const model = getGoogleAI().getGenerativeModel({ model: "gemini-pro" });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error("Error generating text with Google AI:", error);
    throw error;
  }
}
