
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import { generateText } from "@/lib/googleai";

type Agent = {
  id: string;
  name: string;
  description: string | null;
};

type Block = {
  id: string;
  type: string;
  config: any;
};

type Message = {
  id: string;
  content: string;
  sender_type: "user" | "agent";
  created_at: string;
};

type Conversation = {
  id: string;
  title: string;
};

const ChatPage = () => {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function fetchAgentAndSetupChat() {
      if (!id || !user) return;

      try {
        // Fetch agent details
        const { data: agentData, error: agentError } = await supabase
          .from("agents")
          .select("*")
          .eq("id", id)
          .single();

        if (agentError) throw agentError;
        if (!agentData) {
          toast.error("Agent not found");
          navigate("/dashboard");
          return;
        }

        setAgent(agentData);

        // Fetch agent blocks
        const { data: blocksData, error: blocksError } = await supabase
          .from("blocks")
          .select("*")
          .eq("agent_id", id);

        if (blocksError) throw blocksError;
        setBlocks(blocksData || []);

        // Check for existing conversation or create a new one
        const { data: convData, error: convError } = await supabase
          .from("conversations")
          .select("*")
          .eq("agent_id", id)
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(1);

        if (convError) throw convError;

        let conversationId;
        if (convData && convData.length > 0) {
          setConversation(convData[0]);
          conversationId = convData[0].id;
        } else {
          // Create a new conversation
          const { data: newConv, error: newConvError } = await supabase
            .from("conversations")
            .insert({
              agent_id: id,
              user_id: user.id,
              title: agentData.name
            })
            .select()
            .single();

          if (newConvError) throw newConvError;
          setConversation(newConv);
          conversationId = newConv.id;
        }

        // Fetch messages for this conversation
        if (conversationId) {
          const { data: messagesData, error: messagesError } = await supabase
            .from("messages")
            .select("*")
            .eq("conversation_id", conversationId)
            .order("created_at", { ascending: true });

          if (messagesError) throw messagesError;
          setMessages(messagesData || []);
        }
      } catch (error: any) {
        toast.error(error.message || "Failed to load chat");
      } finally {
        setIsLoading(false);
      }
    }

    fetchAgentAndSetupChat();
  }, [id, user, navigate]);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Set up real-time updates for messages
  useEffect(() => {
    if (!conversation) return;

    const channel = supabase
      .channel('schema-db-changes')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversation.id}`
        },
        (payload) => {
          const newMessage = payload.new as Message;
          setMessages(prevMessages => [...prevMessages, newMessage]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversation]);

  const sendMessage = async () => {
    if (!input.trim() || !conversation || !user || isProcessing) return;

    const userMessageContent = input.trim();
    setInput("");
    setIsProcessing(true);

    try {
      // Insert user message
      const { data: userMessage, error: userMessageError } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversation.id,
          sender_type: "user",
          content: userMessageContent
        })
        .select()
        .single();

      if (userMessageError) throw userMessageError;

      // Generate agent response
      const promptBlock = blocks.find(block => block.type === "prompt");
      const googleAIBlock = blocks.find(block => block.type === "googleai");
      
      let systemPrompt = "You are a helpful AI assistant.";
      if (promptBlock && promptBlock.config.prompt) {
        systemPrompt = promptBlock.config.prompt;
      }
      
      // Construct context from previous messages
      const memoryBlock = blocks.find(block => block.type === "memory");
      const maxMessages = memoryBlock?.config?.maxMessages || 10;
      
      const recentMessages = messages
        .slice(-maxMessages)
        .map(msg => `${msg.sender_type === "user" ? "User" : "Assistant"}: ${msg.content}`)
        .join("\n");
      
      // Call Google AI if available, otherwise use fallback text
      let response = "I'm sorry, but I cannot generate a response at the moment.";
      
      if (googleAIBlock) {
        try {
          // You'll need to get the API key securely from your backend/secrets
          const apiKey = await getAPIKey();
          
          const fullPrompt = `${systemPrompt}\n\nConversation history:\n${recentMessages}\n\nUser: ${userMessageContent}\n\nAssistant:`;
          response = await generateText(fullPrompt, apiKey);
        } catch (error: any) {
          console.error("Error generating AI response:", error);
          response = "I encountered an error while processing your request. Please try again later.";
        }
      }

      // Insert agent response
      await supabase
        .from("messages")
        .insert({
          conversation_id: conversation.id,
          sender_type: "agent",
          content: response
        });
        
    } catch (error: any) {
      toast.error(error.message || "Failed to send message");
    } finally {
      setIsProcessing(false);
    }
  };

  // Helper function to get API key (in a real app, you'd fetch this securely from your backend)
  const getAPIKey = async (): Promise<string> => {
    // This is a placeholder. In a real app, you should fetch the API key securely
    return process.env.GOOGLE_AI_API_KEY || "your-api-key";
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-10rem)]">
      <Card className="flex-1 flex flex-col overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle>{agent?.name || "Chat"}</CardTitle>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500">
                Start a conversation with this agent. Ask a question or provide some information.
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${
                  message.sender_type === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[80%] rounded-lg p-3 ${
                    message.sender_type === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary"
                  }`}
                >
                  {message.content}
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </CardContent>
        <div className="p-4 border-t">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage();
            }}
            className="flex gap-2"
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your message..."
              disabled={isProcessing}
            />
            <Button type="submit" disabled={!input.trim() || isProcessing}>
              {isProcessing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
};

export default ChatPage;
