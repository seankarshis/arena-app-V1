// ---------------------------------------------------------------------------
// Arena GraphQL Schema — Full Type Definitions
// ---------------------------------------------------------------------------

export const typeDefs = `#graphql

  # -----------------------------------------------------------------------
  # Scalars & Shared Types
  # -----------------------------------------------------------------------

  scalar JSON

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  # -----------------------------------------------------------------------
  # Tag
  # -----------------------------------------------------------------------

  type Tag {
    id: ID!
    label: String!
    isActive: Boolean!
  }

  # -----------------------------------------------------------------------
  # Question
  # -----------------------------------------------------------------------

  type Question {
    id: ID!
    text: String!
    category: String!
    isActive: Boolean!
    tags: [Tag!]!
  }

  type QuestionEdge {
    cursor: String!
    node: Question!
  }

  type QuestionConnection {
    edges: [QuestionEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  # -----------------------------------------------------------------------
  # Interview Template
  # -----------------------------------------------------------------------

  type InterviewTemplate {
    id: ID!
    name: String!
    description: String
    status: String!
    questions: [TemplateQuestion!]!
  }

  type TemplateQuestion {
    id: ID!
    question: Question!
    sequenceOrder: Int!
    categoryBucket: String!
    isRequired: Boolean!
    followupTriggers: JSON!
  }

  # -----------------------------------------------------------------------
  # User
  # -----------------------------------------------------------------------

  type User {
    id: ID!
    name: String!
    email: String!
    role: String!
    assignedTemplates: [UserTemplateAssignment!]!
    tags: [Tag!]!
    consentStatus: ConsentStatus!
  }

  type UserTemplateAssignment {
    id: ID!
    template: InterviewTemplate!
    assignedAt: String!
    assignedBy: String!
    status: String!
    completedAt: String
  }

  type ConsentStatus {
    dataProcessing: Boolean!
    audioRecording: Boolean!
    aiInteraction: Boolean!
    allGranted: Boolean!
  }

  # -----------------------------------------------------------------------
  # Interview
  # -----------------------------------------------------------------------

  type Interview {
    id: ID!
    user: User!
    template: InterviewTemplate!
    status: String!
    startedAt: String
    completedAt: String
    pausedAt: String
    responses: [InterviewResponse!]!
    costSummary: InterviewCostSummary!
  }

  type InterviewCostSummary {
    totalLlmPromptTokens: Int!
    totalLlmCompletionTokens: Int!
    totalSttDurationSeconds: Float!
    totalTtsCharacters: Int!
  }

  type InterviewEdge {
    cursor: String!
    node: Interview!
  }

  type InterviewConnection {
    edges: [InterviewEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  # -----------------------------------------------------------------------
  # Interview Response
  # -----------------------------------------------------------------------

  type InterviewResponse {
    id: ID!
    questionTextAsAsked: String!
    sequenceNumber: Int!
    isFollowup: Boolean!
    isSkipped: Boolean!
    inputMode: String!
    categoryBucket: String
    rawTranscription: String
    cleanedMarkdown: String
    processingStatus: String!
    errorMessage: String
    respondedAt: String!
    audioMetadata: AudioMetadata
    audioUploadStatus: String!
  }

  type AudioMetadata {
    s3Key: String!
    mimeType: String!
    durationSeconds: Float!
  }

  type InterviewResponseEdge {
    cursor: String!
    node: InterviewResponse!
  }

  type InterviewResponseConnection {
    edges: [InterviewResponseEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  # -----------------------------------------------------------------------
  # Response Draft
  # -----------------------------------------------------------------------

  type ResponseDraft {
    id: ID!
    draftNumber: Int!
    content: String!
    inputMode: String!
    sttConfidenceScore: Float
    audioUploadStatus: String
    createdAt: String!
  }

  type ResponseDraftEdge {
    cursor: String!
    node: ResponseDraft!
  }

  type ResponseDraftConnection {
    edges: [ResponseDraftEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  # -----------------------------------------------------------------------
  # Template Assignment History
  # -----------------------------------------------------------------------

  type TemplateAssignmentRecord {
    id: ID!
    templateId: ID!
    assignedAt: String!
    assignedBy: String!
    unassignedAt: String
    unassignedReason: String
  }

  type TemplateAssignmentRecordEdge {
    cursor: String!
    node: TemplateAssignmentRecord!
  }

  type TemplateAssignmentRecordConnection {
    edges: [TemplateAssignmentRecordEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  # -----------------------------------------------------------------------
  # Audit Log
  # -----------------------------------------------------------------------

  type AuditLogEntry {
    id: ID!
    actorId: ID!
    actorName: String
    action: String!
    entityType: String!
    entityId: ID!
    changes: JSON!
    createdAt: String!
  }

  type AuditLogEdge {
    cursor: String!
    node: AuditLogEntry!
  }

  type AuditLogConnection {
    edges: [AuditLogEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  # -----------------------------------------------------------------------
  # My Assigned Template (for getMyAssignedTemplates)
  # -----------------------------------------------------------------------

  type MyAssignedTemplate {
    assignment: UserTemplateAssignment!
    interviewStatus: String
  }

  # -----------------------------------------------------------------------
  # Input Types
  # -----------------------------------------------------------------------

  input QuestionFilters {
    tagIds: [ID!]
    category: String
    searchText: String
  }

  input FollowupTriggerInput {
    questionId: ID!
    condition: String!
  }

  # -----------------------------------------------------------------------
  # Mutation Payloads
  # -----------------------------------------------------------------------

  type StartInterviewPayload {
    interviewId: ID!
  }

  type SubmitResponsePayload {
    responseId: ID!
  }

  type SkipQuestionPayload {
    success: Boolean!
  }

  type SaveDraftPayload {
    draftId: ID!
  }

  type AudioUploadUrlPayload {
    uploadUrl: String!
    s3Key: String!
  }

  type ConfirmAudioUploadPayload {
    success: Boolean!
  }

  type GrantConsentPayload {
    success: Boolean!
  }

  type RevokeConsentPayload {
    success: Boolean!
  }

  type RequestDataDeletionPayload {
    success: Boolean!
  }

  type UpdateCleanedContentPayload {
    success: Boolean!
  }

  # -----------------------------------------------------------------------
  # Queries
  # -----------------------------------------------------------------------

  type Query {
    _health: String

    """Fetch a user by ID with tags, assigned templates, role, and consent status."""
    getUser(id: ID!): User

    """Fetch the authenticated user's active template assignments with interview status."""
    getMyAssignedTemplates: [MyAssignedTemplate!]!

    """Fetch a single interview with all responses and cost summary."""
    getInterview(id: ID!): Interview

    """Paginated list of interviews for a user."""
    getInterviewsByUser(userId: ID!, first: Int, after: String): InterviewConnection!

    """Fetch a template with full question set, ordering, and triggers."""
    getTemplate(id: ID!): InterviewTemplate

    """Fetch templates filtered by status (not paginated)."""
    getTemplates(status: String): [InterviewTemplate!]!

    """Paginated list of questions with optional filters."""
    getQuestions(
      filters: QuestionFilters
      includeInactive: Boolean
      first: Int
      after: String
    ): QuestionConnection!

    """Fetch tags, optionally filtered by type. Not paginated."""
    getTags(includeInactive: Boolean): [Tag!]!

    """Fetch a single interview response with full artifact data."""
    getInterviewResponse(id: ID!): InterviewResponse

    """Paginated drafts for a response (admin only)."""
    getDraftsForResponse(
      interviewId: ID!
      questionId: ID!
      first: Int
      after: String
    ): ResponseDraftConnection!

    """Paginated template assignment history (admin only)."""
    getTemplateAssignmentHistory(
      userId: ID!
      first: Int
      after: String
    ): TemplateAssignmentRecordConnection!

    """Fetch the authenticated user's current consent status."""
    getMyConsentStatus: ConsentStatus!

    """Paginated audit log (admin only). Filterable by entity, actor, or both."""
    getAuditLog(
      entityType: String
      entityId: ID
      actorId: ID
      first: Int
      after: String
    ): AuditLogConnection!

    """List all users (admin only). Not paginated for POC."""
    listUsers: [User!]!

    """Paginated list of all interviews (admin only)."""
    listAllInterviews(
      status: String
      first: Int
      after: String
    ): InterviewConnection!
  }

  # -----------------------------------------------------------------------
  # Mutations
  # -----------------------------------------------------------------------

  type Mutation {
    # --- Tag management (admin only) ---
    createTag(label: String!): Tag!
    updateTag(id: ID!, label: String, isActive: Boolean): Tag!

    # --- Question management (admin only) ---
    createQuestion(text: String!, category: String!, tagIds: [ID!]): Question!
    updateQuestion(
      id: ID!
      text: String
      category: String
      tagIds: [ID!]
      isActive: Boolean
    ): Question!

    # --- Template management (admin only) ---
    createTemplate(name: String!, description: String): InterviewTemplate!
    updateTemplate(
      id: ID!
      name: String
      description: String
      status: String
    ): InterviewTemplate!
    addQuestionToTemplate(
      templateId: ID!
      questionId: ID!
      sequenceOrder: Int!
      categoryBucket: String!
      isRequired: Boolean
      followupTriggers: JSON
    ): TemplateQuestion!
    updateTemplateQuestion(
      id: ID!
      sequenceOrder: Int
      categoryBucket: String
      isRequired: Boolean
      followupTriggers: JSON
    ): TemplateQuestion!
    reorderTemplateQuestions(templateId: ID!, orderedIds: [ID!]!): [TemplateQuestion!]!
    removeQuestionFromTemplate(id: ID!): Boolean!

    # --- User management (admin only) ---
    assignTemplateToUser(userId: ID!, templateId: ID!): UserTemplateAssignment!
    removeTemplateFromUser(userId: ID!, templateId: ID!): Boolean!
    syncUserRole(userId: ID!): User!

    # --- Consent operations ---
    grantConsent(consentType: String!, consentVersion: String!): GrantConsentPayload!
    revokeConsent(consentType: String!): RevokeConsentPayload!

    # --- Data subject operations ---
    requestDataDeletion: RequestDataDeletionPayload!

    # --- Interview operations ---
    startInterview(templateId: ID!): StartInterviewPayload!
    submitResponse(
      interviewId: ID!
      rawTranscription: String!
      inputMode: String!
    ): SubmitResponsePayload!
    completeInterview(interviewId: ID!): Interview!
    skipQuestion(interviewId: ID!): SkipQuestionPayload!
    pauseInterview(interviewId: ID!): Interview!
    resumeInterview(interviewId: ID!): Interview!

    # --- Audio operations ---
    requestResponseAudioUploadUrl(
      interviewId: ID!
      responseId: ID!
    ): AudioUploadUrlPayload!
    requestDraftAudioUploadUrl(
      interviewId: ID!
      draftId: ID!
    ): AudioUploadUrlPayload!
    confirmAudioUpload(
      responseId: ID!
      s3Key: String!
      mimeType: String!
      durationSeconds: Float!
    ): ConfirmAudioUploadPayload!
    confirmDraftAudioUpload(
      draftId: ID!
      s3Key: String!
      mimeType: String!
      durationSeconds: Float!
    ): ConfirmAudioUploadPayload!

    # --- Draft operations ---
    saveDraft(
      interviewId: ID!
      content: String!
      inputMode: String!
      sttConfidenceScore: Float
    ): SaveDraftPayload!

    # --- Pipeline operations (internal — called by Lambda) ---
    updateCleanedContent(
      interviewResponseId: ID!
      cleanedMarkdown: String!
      cleaningModel: String!
    ): UpdateCleanedContentPayload!
  }
`;
