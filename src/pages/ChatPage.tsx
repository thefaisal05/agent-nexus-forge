
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
          
          // Ensure we're only setting properly typed messages
          if (messagesData) {
            const typedMessages: Message[] = messagesData.map(msg => ({
              id: msg.id,
              content: msg.content,
              sender_type: msg.sender_type as "user" | "agent",
              created_at: msg.created_at
            }));
            setMessages(typedMessages);
          }
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
          const newMessage = payload.new as any;
          // Ensure proper typing of the new message
          const typedMessage: Message = {
            id: newMessage.id,
            content: newMessage.content,
            sender_type: newMessage.sender_type as "user" | "agent",
            created_at: newMessage.created_at
          };
          
          // Only add the message if it's not already in our messages array
          setMessages(prevMessages => {
            // Check if the message already exists
            const messageExists = prevMessages.some(msg => msg.id === typedMessage.id);
            if (messageExists) {
              return prevMessages;
            }
            return [...prevMessages, typedMessage];
          });
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
      // Optimistically add user message to UI immediately
      const optimisticUserMessage: Message = {
        id: `temp-${Date.now()}`,
        content: userMessageContent,
        sender_type: "user",
        created_at: new Date().toISOString()
      };
      
      setMessages(prevMessages => [...prevMessages, optimisticUserMessage]);

      // Insert user message to database
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

      // Replace optimistic message with real one
      setMessages(prevMessages => 
        prevMessages.map(msg => 
          msg.id === optimisticUserMessage.id ? 
            {
              id: userMessage.id,
              content: userMessage.content,
              sender_type: userMessage.sender_type as "user" | "agent",
              created_at: userMessage.created_at
            } : msg
        )
      );

      // Show typing indicator for agent
      const typingMessage: Message = {
        id: `typing-${Date.now()}`,
        sender_type: "agent",
        content: "...",
        created_at: new Date().toISOString()
      };
      
      setMessages(prevMessages => [...prevMessages, typingMessage]);

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
          // Get the API key securely
          const apiKey = await getAPIKey();
          
          if (!apiKey) {
            throw new Error("API key not found");
          }
          
          console.log("Calling generate-response with prompt");
          
          // Use the Supabase function to generate a response
          const { data, error } = await supabase.functions.invoke("generate-response", {
            body: { 
              prompt: `${systemPrompt}\n\nConversation history:\n${recentMessages}\n\nUser: ${userMessageContent}\n\nAssistant:`,
              model: "gemini-pro"
            }
          });
          
          if (error) throw error;
          
          if (data && data.text) {
            response = data.text;
          } else {
            throw new Error("No response from AI service");
          }
          
        } catch (error: any) {
          console.error("Error generating AI response:", error);
          response = "I encountered an error while processing your request. Please try again later.";
        }
      }

      // Remove typing indicator and add real agent response
      setMessages(prevMessages => prevMessages.filter(msg => msg.id !== typingMessage.id));

      // Insert agent response to database
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

  // Helper function to get API key
  const getAPIKey = async (): Promise<string> => {
    try {
      const { data: secretData, error } = await supabase
        .functions.invoke('get-api-key', {
          body: { key: 'API_KEY' }
        });
      
      if (error) throw new Error('Failed to retrieve API key');
      return secretData?.apiKey || "";
    } catch (e) {
      console.error("Error getting API key:", e);
      return "";
    }
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
                      : message.content === "..." 
                        ? "bg-secondary animate-pulse" 
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
              className="flex-1"
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
