"use client"

import React, { useState, useEffect, useRef } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { motion } from "framer-motion"
import { SidebarProvider } from "@/components/ui/sidebar"
import { ChatSidebar } from "@/components/chatbot/ChatSidebar"
import { ChatMessage } from "@/components/chatbot/ChatMessage"
import { ChatInput } from "@/components/chatbot/ChatInput"
import { EmptyState } from "@/components/chatbot/EmptyState"
import { Message, ChatSession } from "@/components/chatbot/types"
import { useToast } from '@/components/ui/toast'
import { SuccessMessage, useSuccessMessage } from '@/components/ui/success-message'
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel, } from '@/components/ui/alert-dialog'
import { Navbar } from '@/components/navbar'
import { useRouter } from 'next/navigation'

const LegalComplianceChatBotContent: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([{
    id: 'welcome',
    text: 'Welcome to the trial Legal Compliance Assistant. You may ask up to 3 questions and upload 1 file.',
    sender: 'bot',
    timestamp: new Date(),
  }])
  const [typingMessageId, setTypingMessageId] = useState<string | null>(null)
  const [currentChat, setCurrentChat] = useState<ChatSession | null>(null)
  const [chatHistory, setChatHistory] = useState<ChatSession[]>([])
  const chatInputRef = useRef<{ addExternalFile?: (f: File) => void } | null>(null)
  const [inputMessage, setInputMessage] = useState('')
  const [uploadedFile, setUploadedFile] = useState<{ file?: File; name: string } | null>(null)
  const [userQuestions, setUserQuestions] = useState(0)
  const [filesUsed, setFilesUsed] = useState(0)
  const [loading, setLoading] = useState(false)
  const [showLoginModal, setShowLoginModal] = useState(false)
  const toast = useToast()
  const { show: showSuccessMessage, message: successMessage, type: messageType, hideMessage } = useSuccessMessage()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  const scrollToBottom = () => { if (messagesEndRef.current) messagesEndRef.current.scrollIntoView({ behavior: 'smooth' }) }
  useEffect(() => { scrollToBottom() }, [messages])

  // Allow only one file in trial
  const handleFileUpload = React.useCallback(async (file: File) => {
    // In the trial users may only upload one file total. Also prevent staging multiple files.
    const filesAllowed = 1
    const filesAvailable = Math.max(0, filesAllowed - filesUsed - (uploadedFile ? 1 : 0))
    if (filesAvailable <= 0) {
      toast.push('No file uploads remaining in the trial.', 'error')
      return
    }
    if (uploadedFile) {
      toast.push('Only one file may be uploaded at a time. Remove the current file first.', 'error')
      return
    }
    const ext = file.name.split('.').pop()?.toLowerCase() || ''
    if (!['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'].includes(ext)) {
      toast.push('Please upload a valid file type (PDF, DOC/DOCX, JPG, PNG).', 'error')
      return
    }
    setUploadedFile({ file, name: file.name })
  }, [uploadedFile, filesUsed, toast])

  // expose addExternalFile to ChatInput via ref so drag/drop and external code can add files
  useEffect(() => {
    chatInputRef.current = { addExternalFile: handleFileUpload }
  }, [handleFileUpload])

  

  const sendMessage = async () => {
    if (!inputMessage.trim() && !uploadedFile) return
    if (userQuestions >= 3) {
      toast.push('Trial limit reached: 3 questions. Please login to continue.', 'error')
      return
    }
    const userMsg: Message = {
      id: Date.now().toString(),
      text: inputMessage.trim() || (uploadedFile ? `File: ${uploadedFile.name}` : ''),
      sender: 'user',
      timestamp: new Date(),
      fileName: uploadedFile?.name,
    }

    const tempTypingId = `temp-${Date.now()}`
    const tempTyping: Message = {
      id: tempTypingId,
      text: uploadedFile ? 'Reading and analyzing your file...' : 'Analyzing your legal query...',
      sender: 'bot',
      timestamp: new Date(),
      isTyping: true,
      isFileReading: !!uploadedFile,
    }

    // Optimistically update UI
    setMessages(prev => [...prev, userMsg, tempTyping])
    setTypingMessageId(tempTypingId)
    setInputMessage('')

    // increment trial question counter
    setUserQuestions(q => q + 1)

    try {
      let tempFileData = null

      // If there's a local file, upload it first to get tempFileData
      if (uploadedFile?.file) {
        const fd = new FormData()
        // the upload endpoint requires a userId in form data; supply a demo id for trial
        fd.append('userId', 'demo-trial-user')
        fd.append('file', uploadedFile.file)
        const uploadRes = await fetch('/api/legalbot/upload', { method: 'POST', body: fd })
        const uploadData = await uploadRes.json()
        if (!uploadRes.ok) {
          throw new Error(uploadData.error || 'Upload failed')
        }
        tempFileData = uploadData.tempFileData
        // If upload was rejected, show a toast
        if (uploadData.rejected || (tempFileData && tempFileData.rejected)) {
          toast.push('Uploaded file was rejected for not appearing to contain legal compliance content.', 'error')
        }
      }

      // Call the main chat API. Use demo header so server accepts no authenticated user.
      const body: Record<string, unknown> = {
        message: userMsg.text,
        title: (currentChat?.title || (userMsg.text || 'New Chat').slice(0, 30)),
      }
      if (tempFileData) body.tempFileData = tempFileData
      if (currentChat?._id) body.chatId = currentChat._id

      const res = await fetch('/api/legalbot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-demo': '1' },
        body: JSON.stringify(body),
      })

      const data = await res.json()
      if (data.error) {
        throw new Error(data.error)
      }

      // If we sent a file successfully, mark it as consumed so no more trial uploads allowed
      if (uploadedFile?.file) {
        setFilesUsed((v) => v + 1)
      }

      // Merge server messages into UI instead of replacing entire list
      if (data.chat?.messages) {
        const serverMessages = data.chat.messages as Message[]
        setMessages((prev) => {
          // preserve existing messages and append any new messages returned by server
          const existingIds = new Set(prev.map((m) => m.id))
          const newOnes = serverMessages.filter((m) => !existingIds.has(m.id))
          return [...prev, ...newOnes]
        })
        // Merge server messages into currentChat (don't overwrite local optimistic history)
        setCurrentChat((prev) => {
          try {
            const base = (prev?.messages ?? messages) as Message[]
            const existingIds = new Set(base.map((m) => m.id))
            const toAdd = serverMessages.filter((m) => !existingIds.has(m.id))
            const merged = [...base, ...toAdd]
            // Use server-provided chat metadata but keep merged messages
            return { ...(data.chat || {}), messages: merged } as ChatSession
          } catch {
            // Fallback to server chat if merging fails
            return data.chat
          }
        })
        // If the latest bot message id exists, set typingMessageId to it (so ChatMessage can animate)
        const latest = serverMessages[serverMessages.length - 1]
        if (latest?.sender === 'bot') setTypingMessageId(latest.id)
      }

      // clear uploadedFile from UI after send
      setUploadedFile(null)
    } catch (err) {
      console.error('Send failed:', err)
      const msg = err instanceof Error ? err.message : String(err)
      toast.push(msg || 'Failed to send message', 'error')
      // remove temp typing message
      setMessages(prev => prev.filter(m => m.id !== tempTypingId))
    } finally {
      setTypingMessageId(null)
      setLoading(false)
    }
  }

  // goToLogin navigates to the login page from the modal
  const goToLogin = () => {
    setShowLoginModal(false)
    router.push('/auth/login')
  }

  // Sidebar actions should prompt login for full functionality in trial
  const handleNewChat = () => {
    setShowLoginModal(true)
  }

  const handleContinueChat = () => {
    setShowLoginModal(true)
  }

  const handleDeleteChat = () => {
    setShowLoginModal(true)
  }

  return (
    <SidebarProvider defaultOpen={false}>
      <TooltipProvider>
        <div className="flex h-screen w-full overflow-hidden">
          <SuccessMessage show={showSuccessMessage} message={successMessage} type={messageType} onClose={hideMessage} />
          <Navbar />

          {/* Sidebar on the left, chat on the right */}
          <ChatSidebar
            chatHistory={chatHistory}
            onNewChat={handleNewChat}
            onContinueChat={handleContinueChat}
            onDeleteChat={handleDeleteChat}
            onShareWhatsApp={() => toast.push('Sharing disabled in trial', 'error')}
            onShareEmail={() => toast.push('Sharing disabled in trial', 'error')}
            onShareInstagram={() => toast.push('Sharing disabled in trial', 'error')}
            onCopyLink={() => toast.push('Sharing disabled in trial', 'error')}
            onDeleteAll={() => { setChatHistory([]); setCurrentChat(null); setMessages([{ id: `welcome-${Date.now()}`, text: 'All trial history cleared.', sender: 'bot', timestamp: new Date() }]) }}
          />

          {/* Main chat panel (visual layout matches /user/chatbot) */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.15 }}
            // Panel spans the full viewport so the inner max-w container can be centered
            className="fixed top-16 bottom-0 left-0 right-0 z-40 flex flex-col bg-background"
          >
            <div className="flex-1 overflow-y-auto px-2 sm:px-5 pb-24">
              <div className="flex flex-col items-center w-full">
                <div className="w-full max-w-2xl pb-5 pt-5">
                  {(currentChat?.messages || messages).length > 0 ? (
                    <div className="space-y-6">
                      {(currentChat?.messages || messages).map((msg, i) => (
                        <div key={msg.id} className="mb-6">
                          <ChatMessage
                            message={msg}
                            index={i}
                            typingMessageId={typingMessageId}
                            onTypingComplete={() => setTypingMessageId(null)}
                          />
                        </div>
                      ))}
                      <div ref={messagesEndRef} />

                      {/* Trial login prompts shown as chat-style bot messages inside the message stream */}
                      {userQuestions >= 3 && (
                        <>
                

                          <div className="mb-6 flex justify-start">
                            <div className="rounded-2xl px-4 py-3 flex flex-col items-center justify-center relative shadow-sm bg-white border border-gray-100 text-red-600 max-w-[85%]">
                              <div className="text-sm">You have reached the trial limit of 3 questions. Login to ask more about legal compliance.</div>
                                <div className="mt-3">
                                  <button
                                    onClick={goToLogin}
                                    className="bg-primary text-primary-foreground px-3 py-1.5 rounded-md shadow hover:bg-primary/90"
                                  >
                                    Login
                                  </button>
                                </div>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  ) : (
                    <EmptyState />
                  )}
                </div>
              </div>
            </div>

            {/* Chat input fixed at the bottom of the panel */}
            <div className="w-full relative">
              <ChatInput
                ref={chatInputRef}
                inputMessage={inputMessage}
                loading={loading}
                dragActive={false}
                placeholder={`You have ${3 - userQuestions} question${userQuestions === 2 ? '' : 's'} left and ${Math.max(0, 1 - filesUsed - (uploadedFile ? 1 : 0))} file upload${Math.max(0, 1 - filesUsed - (uploadedFile ? 1 : 0)) === 1 ? '' : 's'} available`}
                onUploadClick={() => {
                  const filesAllowed = 1
                  const filesAvailable = Math.max(0, filesAllowed - filesUsed - (uploadedFile ? 1 : 0))
                  if (filesAvailable <= 0) {
                    // show login modal instead of upload
                    setShowLoginModal(true)
                    return false
                  }
                  return true
                }}
                onInputChange={setInputMessage}
                onSendMessage={sendMessage}
                onFileUpload={handleFileUpload}
                // Lock input when bot is typing, when loading, or when trial question limit reached
                locked={!!typingMessageId || loading || userQuestions >= 3}
                uploadedFile={uploadedFile}
                // Allow removing a staged upload before sending
                onRemoveFile={() => {
                  setUploadedFile(null)
                }}
              />

              {/* removed bottom banner/button — login prompts are rendered in the message stream as chat bubbles */}
            </div>
          </motion.div>

          {/* Login prompt dialog for New Chat */}
          <AlertDialog open={showLoginModal} onOpenChange={setShowLoginModal}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Login required</AlertDialogTitle>
                <AlertDialogDescription>
                  The trial assistant is limited. Please login to access the full-featured chatbot (unlimited questions, file uploads, history and sharing).
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setShowLoginModal(false)}>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={goToLogin} className="ml-2">Login</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </TooltipProvider>
    </SidebarProvider>
  )
}

const LegalComplianceChatBot: React.FC = () => (
  <LegalComplianceChatBotContent />
)

export default LegalComplianceChatBot
