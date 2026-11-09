/*******************************************************************************
 * ARAMS - Academic Registration and Assessment Management System
 * Backend API for Google Apps Script + Google Sheets + GitHub Pages frontend
 * Version : 1.0.0
 * Runtime : Google Apps Script V8
 *
 * IMPORTANT
 * 1) Set Script Properties before production deployment:
 *      SPREADSHEET_ID          (optional; omitted = create a new spreadsheet)
 *      IMGBB_API_KEY           (required for image uploads)
 *      INITIAL_ADMIN_EMAIL     (used once by bootstrapInitialAdminFromProperties)
 *      INITIAL_ADMIN_PASSWORD  (used once by bootstrapInitialAdminFromProperties)
 *      INITIAL_ADMIN_NAME      (optional)
 * 2) Run initializeAramsDatabase() once from the Apps Script editor.
 * 3) Set the three INITIAL_ADMIN_* properties, then run
 *    bootstrapInitialAdminFromProperties() once. The password property is
 *    deleted automatically after a successful bootstrap.
 * 4) Deploy as Web App. Execute as: Me. Access: Anyone (or the audience that
 *    matches the school's Google Workspace policy). Protect the API with the
 *    ARAMS login/session system and deploy only after reviewing security.
 * 5) This file does not expose API keys or passwords to index.html.
 *
 * API request (POST, JSON body; frontend should send Content-Type text/plain):
 *   {
 *     "action": "data.list",
 *     "token": "SESSION_TOKEN",
 *     "data": {
 *       "module": "students",
 *       "table": "STUDENTS",
 *       "page": 1,
 *       "pageSize": 50,
 *       "q": "คำค้น",
 *       "filters": {"academicYear": "2569", "status": "ACTIVE"}
 *     }
 *   }
 *
 * Standard response:
 *   {"success":true,"message":"ดำเนินการเรียบร้อยแล้ว","data":{...}}
 *   {"success":false,"message":"ไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง"}
 *
 * NOTE ABOUT GITHUB PAGES / CORS:
 * Apps Script ContentService does not provide a supported method to set
 * arbitrary CORS response headers. Cross-origin browser fetch from GitHub
 * Pages must be tested in the actual deployment. If the browser blocks the
 * response, use a same-origin proxy (recommended: Cloudflare Worker) or serve
 * the frontend from Apps Script HtmlService. Do not use no-cors because its
 * response is unreadable, and do not expose session tokens through JSONP URLs.
 ******************************************************************************/

/* ========================================================================== *
 *  SECTION 01 - GLOBAL CONFIGURATION
 * ========================================================================== */

const ARAMS_CONFIG = Object.freeze({
  APP_NAME: 'ARAMS',
  APP_VERSION: '1.0.0',
  TIME_ZONE: 'Asia/Bangkok',
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 200,
  MAX_BULK_ROWS: 200,
  MAX_SEARCH_LENGTH: 120,
  SESSION_TTL_SECONDS: 21600, // 6 hours; CacheService may evict earlier.
  LOGIN_LOCK_SECONDS: 900,
  LOGIN_MAX_ATTEMPTS: 5,
  LOCK_WAIT_MS: 20000,
  MAX_IMAGE_BYTES: 5 * 1024 * 1024, // 5 MB application limit for stable transfer.
  ALLOWED_IMAGE_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
  IMGBB_UPLOAD_URL: 'https://api.imgbb.com/1/upload',
  DEFAULT_SCHOOL_NAME: 'โรงเรียนในสังกัดองค์การบริหารส่วนจังหวัดพัทลุง',
  SOFT_DELETE_STATUS: 'DELETED',
  ACTIVE_STATUS: 'ACTIVE'
});

const SCRIPT_PROPERTY_KEYS = Object.freeze({
  SPREADSHEET_ID: 'SPREADSHEET_ID',
  IMGBB_API_KEY: 'IMGBB_API_KEY',
  INITIAL_ADMIN_EMAIL: 'INITIAL_ADMIN_EMAIL',
  INITIAL_ADMIN_PASSWORD: 'INITIAL_ADMIN_PASSWORD',
  INITIAL_ADMIN_NAME: 'INITIAL_ADMIN_NAME',
  APP_SECRET: 'ARAMS_APP_SECRET'
});

/* ========================================================================== *
 *  SECTION 02 - DATABASE SCHEMA
 *  ทุกชีตมีคอลัมน์ id / createdAt / updatedAt / createdBy / updatedBy / status
 *  ระบบเพิ่มคอลัมน์ที่ขาดได้โดยไม่ลบข้อมูลเดิม
 * ========================================================================== */

const COMMON_HEADERS = [
  'id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'status', 'notes',
  'deletedAt', 'deletedBy', 'deletionReason'
];

const ARAMS_SCHEMA = {
  SYSTEM_SETTINGS: COMMON_HEADERS.concat([
    'settingKey', 'settingValue', 'settingType', 'description', 'isPublic'
  ]),
  SCHOOL_PROFILE: COMMON_HEADERS.concat([
    'schoolCode', 'schoolName', 'schoolNameEn', 'department', 'localAuthority',
    'province', 'district', 'subDistrict', 'address', 'phone', 'email',
    'website', 'logoUrl', 'academicDirectorName', 'principalName'
  ]),
  USERS: COMMON_HEADERS.concat([
    'email', 'username', 'passwordHash', 'passwordSalt', 'displayName',
    'firstName', 'lastName', 'phone', 'roleCodes', 'teacherId', 'studentId',
    'guardianId', 'lastLoginAt', 'passwordChangedAt', 'mustChangePassword',
    'failedLoginCount', 'lockedUntil'
  ]),
  ROLES: COMMON_HEADERS.concat([
    'roleCode', 'roleName', 'description', 'isSystemRole', 'sortOrder'
  ]),
  PERMISSIONS: COMMON_HEADERS.concat([
    'permissionCode', 'permissionName', 'moduleCode', 'actionCode', 'description'
  ]),
  ROLE_PERMISSIONS: COMMON_HEADERS.concat([
    'roleCode', 'permissionCode', 'allowed'
  ]),
  AUDIT_LOGS: COMMON_HEADERS.concat([
    'actorUserId', 'actorEmail', 'actorName', 'action', 'module', 'tableName',
    'recordId', 'beforeJson', 'afterJson', 'reason', 'ipAddress', 'userAgent'
  ]),
  ACADEMIC_YEARS: COMMON_HEADERS.concat([
    'yearCode', 'yearName', 'startDate', 'endDate', 'isCurrent', 'isLocked'
  ]),
  ACADEMIC_TERMS: COMMON_HEADERS.concat([
    'academicYear', 'termCode', 'termName', 'startDate', 'endDate',
    'registrationStart', 'registrationEnd', 'gradeSubmitDeadline', 'isCurrent', 'isLocked'
  ]),
  STUDENTS: COMMON_HEADERS.concat([
    'studentCode', 'nationalId', 'title', 'firstName', 'lastName', 'firstNameEn',
    'lastNameEn', 'nickname', 'gender', 'birthDate', 'bloodGroup', 'religion',
    'nationality', 'ethnicity', 'phone', 'email', 'lineId', 'addressNo',
    'villageNo', 'road', 'subDistrict', 'district', 'province', 'postalCode',
    'currentAddress', 'photoUrl', 'admissionYear', 'admissionLevel', 'currentLevel',
    'currentClassroomId', 'currentClassName', 'studyPlanId', 'studentType',
    'previousSchool', 'previousSchoolProvince', 'specialNeeds', 'medicalNotes',
    'emergencyContactName', 'emergencyContactRelation', 'emergencyContactPhone',
    'enrollmentDate', 'graduationDate', 'studentStatus', 'userId'
  ]),
  GUARDIANS: COMMON_HEADERS.concat([
    'guardianCode', 'nationalId', 'title', 'firstName', 'lastName', 'relation',
    'phone', 'phoneSecondary', 'email', 'occupation', 'workplace', 'address',
    'lineId', 'photoUrl', 'userId'
  ]),
  STUDENT_GUARDIANS: COMMON_HEADERS.concat([
    'studentId', 'guardianId', 'relation', 'isPrimary', 'canReceiveNotifications',
    'canViewAcademicRecords', 'canSubmitRequests'
  ]),
  STUDENT_EDUCATION_HISTORY: COMMON_HEADERS.concat([
    'studentId', 'academicYear', 'schoolName', 'level', 'className', 'gpa',
    'startDate', 'endDate', 'documentUrl'
  ]),
  STUDENT_STATUS_HISTORY: COMMON_HEADERS.concat([
    'studentId', 'oldStatus', 'newStatus', 'effectiveDate', 'reason', 'approvedBy'
  ]),
  STUDENT_DOCUMENTS: COMMON_HEADERS.concat([
    'studentId', 'documentType', 'documentName', 'fileUrl', 'fileMimeType',
    'fileSize', 'issuedDate', 'expiryDate', 'verifiedBy', 'verifiedAt'
  ]),
  ADMISSIONS: COMMON_HEADERS.concat([
    'applicationNo', 'academicYear', 'admissionLevel', 'admissionType',
    'title', 'firstName', 'lastName', 'nationalId', 'gender', 'birthDate',
    'phone', 'email', 'address', 'previousSchool', 'previousGpa', 'photoUrl',
    'guardianName', 'guardianRelation', 'guardianPhone', 'documentStatus',
    'examNumber', 'examScore', 'interviewScore', 'totalScore', 'selectionStatus',
    'reportingStatus', 'studentId', 'submittedAt', 'approvedAt', 'approvedBy'
  ]),
  ADMISSION_DOCUMENTS: COMMON_HEADERS.concat([
    'admissionId', 'documentType', 'documentName', 'fileUrl', 'verified',
    'verifiedBy', 'verifiedAt', 'remark'
  ]),
  ADMISSION_EXAMS: COMMON_HEADERS.concat([
    'academicYear', 'admissionLevel', 'examName', 'examDate', 'examStartTime',
    'examEndTime', 'examRoom', 'maxScore', 'weight', 'isActive'
  ]),
  ADMISSION_RESULTS: COMMON_HEADERS.concat([
    'admissionId', 'examId', 'examScore', 'interviewScore', 'totalScore',
    'rankNo', 'selectionStatus', 'announcementDate'
  ]),
  CURRICULA: COMMON_HEADERS.concat([
    'curriculumCode', 'curriculumName', 'curriculumLevel', 'startAcademicYear',
    'endAcademicYear', 'curriculumType', 'documentUrl', 'isCurrent', 'approvedDate'
  ]),
  CURRICULUM_VERSIONS: COMMON_HEADERS.concat([
    'curriculumId', 'versionCode', 'versionName', 'effectiveAcademicYear',
    'documentUrl', 'changeSummary', 'isActive'
  ]),
  LEARNING_AREAS: COMMON_HEADERS.concat([
    'areaCode', 'areaName', 'areaNameEn', 'sortOrder', 'curriculumId'
  ]),
  SUBJECTS: COMMON_HEADERS.concat([
    'subjectCode', 'subjectName', 'subjectNameEn', 'learningAreaId',
    'subjectType', 'levelRange', 'credit', 'totalHours', 'semesterHours',
    'isCore', 'isElective', 'prerequisiteSubjectIds', 'gradingType',
    'description', 'curriculumId', 'isActive'
  ]),
  CURRICULUM_SUBJECTS: COMMON_HEADERS.concat([
    'curriculumId', 'academicYear', 'level', 'subjectId', 'subjectType',
    'termNo', 'credit', 'hours', 'requiredForGraduation'
  ]),
  STUDY_PLANS: COMMON_HEADERS.concat([
    'planCode', 'planName', 'levelStart', 'levelEnd', 'curriculumId',
    'academicYearStart', 'academicYearEnd', 'description', 'isActive'
  ]),
  STUDY_PLAN_SUBJECTS: COMMON_HEADERS.concat([
    'studyPlanId', 'subjectId', 'level', 'termNo', 'credit', 'hours',
    'subjectType', 'isRequired', 'sortOrder'
  ]),
  GRADUATION_REQUIREMENTS: COMMON_HEADERS.concat([
    'curriculumId', 'level', 'requirementCode', 'requirementName',
    'minimumCredits', 'minimumHours', 'requiredSubjectType', 'minimumGpa',
    'isRequired', 'ruleJson'
  ]),
  GRADE_SCALE: COMMON_HEADERS.concat([
    'scaleCode', 'scaleName', 'curriculumId', 'minScore', 'maxScore',
    'gradeLabel', 'gradePoint', 'passStatus', 'sortOrder'
  ]),
  CLASSROOMS: COMMON_HEADERS.concat([
    'academicYear', 'level', 'className', 'roomNo', 'homeroomTeacherId',
    'capacity', 'studyPlanId', 'building', 'floor', 'isActive'
  ]),
  CLASS_MEMBERSHIPS: COMMON_HEADERS.concat([
    'studentId', 'classroomId', 'academicYear', 'level', 'className',
    'startDate', 'endDate', 'membershipStatus'
  ]),
  COURSE_SECTIONS: COMMON_HEADERS.concat([
    'academicYear', 'termCode', 'subjectId', 'sectionCode', 'sectionName',
    'level', 'classroomId', 'studyPlanId', 'teacherId', 'maxStudents',
    'registeredCount', 'roomId', 'dayPattern', 'isActive'
  ]),
  REGISTRATIONS: COMMON_HEADERS.concat([
    'registrationNo', 'studentId', 'academicYear', 'termCode', 'subjectId',
    'courseSectionId', 'subjectCode', 'subjectName', 'credit', 'subjectType',
    'registrationDate', 'registrationStatus', 'withdrawalDate', 'approvedBy'
  ]),
  REGISTRATION_CHANGES: COMMON_HEADERS.concat([
    'registrationId', 'studentId', 'oldSubjectId', 'newSubjectId', 'changeType',
    'requestDate', 'reason', 'approvedBy', 'approvedAt'
  ]),
  TIMETABLES: COMMON_HEADERS.concat([
    'academicYear', 'termCode', 'level', 'classroomId', 'className',
    'timetableName', 'effectiveDate', 'endDate', 'isPublished'
  ]),
  TIMETABLE_ENTRIES: COMMON_HEADERS.concat([
    'timetableId', 'dayOfWeek', 'periodNo', 'startTime', 'endTime',
    'subjectId', 'courseSectionId', 'teacherId', 'roomId', 'classroomId'
  ]),
  ROOMS: COMMON_HEADERS.concat([
    'roomCode', 'roomName', 'roomType', 'building', 'floor', 'capacity',
    'equipment', 'isAvailable'
  ]),
  TEACHER_ASSIGNMENTS: COMMON_HEADERS.concat([
    'teacherId', 'courseSectionId', 'subjectId', 'academicYear', 'termCode',
    'classroomId', 'assignmentRole', 'hoursPerWeek'
  ]),
  ATTENDANCE: COMMON_HEADERS.concat([
    'studentId', 'academicYear', 'termCode', 'subjectId', 'courseSectionId',
    'classroomId', 'attendanceDate', 'periodNo', 'attendanceStatus',
    'teacherId', 'recordedAt', 'verifiedBy', 'reason'
  ]),
  ATTENDANCE_SUMMARIES: COMMON_HEADERS.concat([
    'studentId', 'academicYear', 'termCode', 'subjectId', 'courseSectionId',
    'totalPeriods', 'presentPeriods', 'latePeriods', 'absentPeriods',
    'leavePeriods', 'attendancePercent', 'calculatedAt'
  ]),
  ASSESSMENT_SCHEMES: COMMON_HEADERS.concat([
    'academicYear', 'termCode', 'subjectId', 'courseSectionId', 'teacherId',
    'schemeName', 'totalScore', 'passScore', 'gradingRuleJson', 'isLocked'
  ]),
  ASSESSMENT_ITEMS: COMMON_HEADERS.concat([
    'schemeId', 'academicYear', 'termCode', 'subjectId', 'courseSectionId',
    'teacherId', 'itemName', 'itemType', 'maxScore', 'weight', 'assessmentDate',
    'sortOrder', 'isPublished'
  ]),
  SCORES: COMMON_HEADERS.concat([
    'studentId', 'assessmentItemId', 'schemeId', 'academicYear', 'termCode',
    'subjectId', 'courseSectionId', 'teacherId', 'score', 'maxScore',
    'scoreDate', 'isAbsent', 'remark', 'verifiedBy'
  ]),
  GRADE_RESULTS: COMMON_HEADERS.concat([
    'studentId', 'academicYear', 'termCode', 'subjectId', 'courseSectionId',
    'teacherId', 'totalScore', 'gradeLabel', 'gradePoint', 'resultCode',
    'credit', 'creditEarned', 'attendancePercent', 'assessmentStatus',
    'submittedAt', 'approvedAt', 'approvedBy', 'isLocked', 'revisionNo'
  ]),
  GRADE_APPROVALS: COMMON_HEADERS.concat([
    'gradeResultId', 'studentId', 'subjectId', 'academicYear', 'termCode',
    'workflowStep', 'approverUserId', 'decision', 'decisionDate', 'reason'
  ]),
  GRADE_IMPROVEMENT_CASES: COMMON_HEADERS.concat([
    'studentId', 'academicYear', 'termCode', 'subjectId', 'gradeResultId',
    'originalResultCode', 'improvementType', 'caseStatus', 'assignedTeacherId',
    'openedDate', 'dueDate', 'completedDate', 'finalResultCode', 'approvedBy'
  ]),
  GRADE_IMPROVEMENT_ACTIVITIES: COMMON_HEADERS.concat([
    'caseId', 'studentId', 'teacherId', 'activityDate', 'activityType',
    'description', 'score', 'resultCode', 'evidenceUrl', 'verifiedBy'
  ]),
  STUDENT_ACTIVITY_RESULTS: COMMON_HEADERS.concat([
    'studentId', 'academicYear', 'termCode', 'activityCode', 'activityName',
    'activityType', 'resultCode', 'hours', 'teacherId', 'approvedBy'
  ]),
  CHARACTER_ASSESSMENTS: COMMON_HEADERS.concat([
    'studentId', 'academicYear', 'termCode', 'assessmentLevel', 'resultCode',
    'assessorId', 'assessmentDate', 'detailJson'
  ]),
  READING_THINKING_ASSESSMENTS: COMMON_HEADERS.concat([
    'studentId', 'academicYear', 'termCode', 'assessmentLevel', 'resultCode',
    'assessorId', 'assessmentDate', 'detailJson'
  ]),
  COMPETENCY_ASSESSMENTS: COMMON_HEADERS.concat([
    'studentId', 'academicYear', 'termCode', 'competencyCode', 'competencyName',
    'assessmentLevel', 'resultCode', 'assessorId', 'assessmentDate', 'detailJson'
  ]),
  STUDENT_CREDITS: COMMON_HEADERS.concat([
    'studentId', 'academicYear', 'termCode', 'subjectId', 'subjectCode',
    'credit', 'creditEarned', 'resultCode', 'curriculumId'
  ]),
  GRADUATION_AUDITS: COMMON_HEADERS.concat([
    'studentId', 'academicYear', 'level', 'curriculumId', 'auditStatus',
    'totalCredits', 'earnedCredits', 'requiredCredits', 'gpa',
    'outstandingItemsJson', 'auditedAt', 'auditedBy'
  ]),
  GRADUATES: COMMON_HEADERS.concat([
    'studentId', 'academicYear', 'graduationLevel', 'graduationDate',
    'approvalDate', 'certificateNo', 'transcriptNo', 'graduationStatus',
    'gpa', 'curriculumId', 'approvedBy'
  ]),
  ACADEMIC_DOCUMENTS: COMMON_HEADERS.concat([
    'studentId', 'documentType', 'documentNo', 'academicYear', 'issuedDate',
    'purpose', 'requestId', 'fileUrl', 'issuedBy', 'verifiedCode', 'documentStatus'
  ]),
  DOCUMENT_COUNTERS: COMMON_HEADERS.concat([
    'documentType', 'academicYear', 'prefix', 'lastNumber', 'numberFormat'
  ]),
  TEACHERS: COMMON_HEADERS.concat([
    'teacherCode', 'nationalId', 'title', 'firstName', 'lastName', 'gender',
    'birthDate', 'phone', 'email', 'position', 'academicStanding',
    'learningAreaId', 'employmentType', 'startDate', 'photoUrl', 'userId', 'isActive'
  ]),
  TEACHER_PROFILES: COMMON_HEADERS.concat([
    'teacherId', 'educationJson', 'expertise', 'certificationsJson',
    'trainingJson', 'biography', 'portfolioUrl'
  ]),
  TEACHER_WORKLOAD: COMMON_HEADERS.concat([
    'teacherId', 'academicYear', 'termCode', 'teachingHours', 'homeroomHours',
    'administrativeHours', 'otherHours', 'totalHours', 'approvedBy'
  ]),
  ADVISOR_ASSIGNMENTS: COMMON_HEADERS.concat([
    'teacherId', 'classroomId', 'academicYear', 'termCode', 'level', 'className',
    'studentIdsJson', 'isPrimary'
  ]),
  COUNSELING_RECORDS: COMMON_HEADERS.concat([
    'studentId', 'advisorTeacherId', 'recordDate', 'topic', 'summary',
    'actionPlan', 'followUpDate', 'followUpStatus', 'confidentialLevel'
  ]),
  STUDENT_ALERTS: COMMON_HEADERS.concat([
    'studentId', 'academicYear', 'termCode', 'alertType', 'severity',
    'alertTitle', 'alertDetail', 'sourceModule', 'assignedTo', 'alertStatus',
    'detectedAt', 'resolvedAt', 'resolutionNote'
  ]),
  STUDENT_PORTFOLIOS: COMMON_HEADERS.concat([
    'studentId', 'academicYear', 'portfolioTitle', 'portfolioDescription',
    'coverImageUrl', 'visibility', 'approvedBy', 'publishedAt'
  ]),
  PORTFOLIO_ITEMS: COMMON_HEADERS.concat([
    'portfolioId', 'studentId', 'itemTitle', 'itemType', 'description',
    'imageUrl', 'fileUrl', 'achievementDate', 'issuer', 'awardLevel',
    'verificationStatus', 'sortOrder'
  ]),
  SCHOOL_EVENTS: COMMON_HEADERS.concat([
    'eventTitle', 'eventType', 'startDate', 'endDate', 'location',
    'description', 'coverImageUrl', 'organizer', 'targetAudience', 'isPublished'
  ]),
  ACADEMIC_CALENDAR: COMMON_HEADERS.concat([
    'academicYear', 'termCode', 'eventTitle', 'eventType', 'startDate',
    'endDate', 'description', 'targetRoles', 'isAllDay', 'reminderAt'
  ]),
  NOTIFICATIONS: COMMON_HEADERS.concat([
    'recipientUserId', 'recipientRole', 'title', 'message', 'notificationType',
    'referenceModule', 'referenceId', 'isRead', 'readAt', 'scheduledAt', 'sentAt'
  ]),
  PARENT_LINKS: COMMON_HEADERS.concat([
    'parentUserId', 'guardianId', 'studentId', 'relation', 'isVerified',
    'canViewGrades', 'canViewAttendance', 'canSubmitRequests'
  ]),
  SERVICE_REQUESTS: COMMON_HEADERS.concat([
    'requestNo', 'requestType', 'requesterUserId', 'requesterRole',
    'studentId', 'subject', 'details', 'attachmentUrl', 'requestStatus',
    'currentAssignee', 'submittedAt', 'completedAt', 'resultMessage'
  ]),
  SERVICE_REQUEST_HISTORY: COMMON_HEADERS.concat([
    'requestId', 'fromStatus', 'toStatus', 'actionBy', 'actionDate',
    'actionNote', 'assignedTo'
  ]),
  LEC_DATA_CHECKS: COMMON_HEADERS.concat([
    'academicYear', 'termCode', 'checkType', 'recordCount', 'errorCount',
    'warningCount', 'checkResultJson', 'checkedAt', 'checkedBy'
  ]),
  LEC_EXPORT_JOBS: COMMON_HEADERS.concat([
    'academicYear', 'termCode', 'exportType', 'fileName', 'fileUrl',
    'recordCount', 'exportStatus', 'generatedAt', 'generatedBy', 'remarks'
  ]),
  REPORT_SNAPSHOTS: COMMON_HEADERS.concat([
    'reportCode', 'reportName', 'academicYear', 'termCode', 'filtersJson',
    'dataJson', 'generatedAt', 'generatedBy'
  ]),
  IMAGE_UPLOADS: COMMON_HEADERS.concat([
    'ownerModule', 'ownerRecordId', 'fileName', 'mimeType', 'fileSize',
    'imageUrl', 'displayUrl', 'deleteUrl', 'imageId', 'uploadedBy', 'uploadedAt'
  ]),
  AUTH_ATTEMPTS: COMMON_HEADERS.concat([
    'emailKey', 'attemptCount', 'lastAttemptAt', 'lockedUntil'
  ])
};

/* ========================================================================== *
 *  SECTION 03 - MODULE REGISTRY AND TABLE ACCESS MAP
 * ========================================================================== */

const ARAMS_MODULES = {
  dashboard: { code: 'dashboard', label: 'Dashboard', tables: [], defaultTable: '', readOnly: true },
  students: { code: 'students', label: 'ทะเบียนนักเรียน', tables: ['STUDENTS', 'GUARDIANS', 'STUDENT_GUARDIANS', 'STUDENT_EDUCATION_HISTORY', 'STUDENT_STATUS_HISTORY', 'STUDENT_DOCUMENTS'], defaultTable: 'STUDENTS' },
  admissions: { code: 'admissions', label: 'รับสมัครนักเรียน', tables: ['ADMISSIONS', 'ADMISSION_DOCUMENTS', 'ADMISSION_EXAMS', 'ADMISSION_RESULTS'], defaultTable: 'ADMISSIONS' },
  curriculum: { code: 'curriculum', label: 'หลักสูตรและรายวิชา', tables: ['CURRICULA', 'CURRICULUM_VERSIONS', 'LEARNING_AREAS', 'SUBJECTS', 'CURRICULUM_SUBJECTS', 'STUDY_PLANS', 'STUDY_PLAN_SUBJECTS', 'GRADUATION_REQUIREMENTS', 'GRADE_SCALE'], defaultTable: 'SUBJECTS' },
  registration: { code: 'registration', label: 'ลงทะเบียนเรียน', tables: ['CLASSROOMS', 'CLASS_MEMBERSHIPS', 'COURSE_SECTIONS', 'REGISTRATIONS', 'REGISTRATION_CHANGES'], defaultTable: 'REGISTRATIONS' },
  timetable: { code: 'timetable', label: 'ตารางเรียนและตารางสอน', tables: ['TIMETABLES', 'TIMETABLE_ENTRIES', 'ROOMS', 'TEACHER_ASSIGNMENTS'], defaultTable: 'TIMETABLES' },
  attendance: { code: 'attendance', label: 'เวลาเรียน', tables: ['ATTENDANCE', 'ATTENDANCE_SUMMARIES'], defaultTable: 'ATTENDANCE' },
  assessment: { code: 'assessment', label: 'วัดผลและประเมินผล', tables: ['ASSESSMENT_SCHEMES', 'ASSESSMENT_ITEMS', 'SCORES', 'GRADE_RESULTS', 'GRADE_APPROVALS', 'STUDENT_ACTIVITY_RESULTS', 'CHARACTER_ASSESSMENTS', 'READING_THINKING_ASSESSMENTS', 'COMPETENCY_ASSESSMENTS'], defaultTable: 'ASSESSMENT_ITEMS' },
  gradeImprovement: { code: 'gradeImprovement', label: 'แก้ไขผลการเรียน', tables: ['GRADE_IMPROVEMENT_CASES', 'GRADE_IMPROVEMENT_ACTIVITIES'], defaultTable: 'GRADE_IMPROVEMENT_CASES' },
  graduation: { code: 'graduation', label: 'ทะเบียนและสำเร็จการศึกษา', tables: ['STUDENT_CREDITS', 'GRADUATION_AUDITS', 'GRADUATES', 'ACADEMIC_DOCUMENTS', 'DOCUMENT_COUNTERS'], defaultTable: 'GRADUATES' },
  analytics: { code: 'analytics', label: 'วิเคราะห์ผลการเรียน', tables: ['GRADE_RESULTS', 'SCORES', 'ATTENDANCE_SUMMARIES', 'REPORT_SNAPSHOTS'], defaultTable: 'GRADE_RESULTS', readOnly: true },
  teachers: { code: 'teachers', label: 'ครูและครูที่ปรึกษา', tables: ['TEACHERS', 'TEACHER_PROFILES', 'TEACHER_WORKLOAD', 'ADVISOR_ASSIGNMENTS', 'COUNSELING_RECORDS', 'STUDENT_ALERTS'], defaultTable: 'TEACHERS' },
  portal: { code: 'portal', label: 'นักเรียนและผู้ปกครอง', tables: ['PARENT_LINKS', 'NOTIFICATIONS', 'STUDENT_DOCUMENTS', 'GRADE_RESULTS', 'ATTENDANCE_SUMMARIES'], defaultTable: 'NOTIFICATIONS' },
  reports: { code: 'reports', label: 'รายงานสารสนเทศ', tables: ['REPORT_SNAPSHOTS', 'LEC_DATA_CHECKS', 'LEC_EXPORT_JOBS'], defaultTable: 'REPORT_SNAPSHOTS', readOnly: true },
  settings: { code: 'settings', label: 'ตั้งค่าระบบ', tables: ['SYSTEM_SETTINGS', 'SCHOOL_PROFILE', 'USERS', 'ROLES', 'PERMISSIONS', 'ROLE_PERMISSIONS'], defaultTable: 'SYSTEM_SETTINGS' },
  lec: { code: 'lec', label: 'ข้อมูลต้นสังกัดและ LEC', tables: ['LEC_DATA_CHECKS', 'LEC_EXPORT_JOBS'], defaultTable: 'LEC_DATA_CHECKS' },
  calendar: { code: 'calendar', label: 'ปฏิทินวิชาการ', tables: ['ACADEMIC_YEARS', 'ACADEMIC_TERMS', 'ACADEMIC_CALENDAR', 'SCHOOL_EVENTS'], defaultTable: 'ACADEMIC_CALENDAR' },
  portfolio: { code: 'portfolio', label: 'แฟ้มสะสมผลงาน', tables: ['STUDENT_PORTFOLIOS', 'PORTFOLIO_ITEMS'], defaultTable: 'STUDENT_PORTFOLIOS' },
  studentSupport: { code: 'studentSupport', label: 'ดูแลช่วยเหลือนักเรียน', tables: ['COUNSELING_RECORDS', 'STUDENT_ALERTS', 'ATTENDANCE', 'GRADE_RESULTS'], defaultTable: 'STUDENT_ALERTS' },
  services: { code: 'services', label: 'คำร้องออนไลน์', tables: ['SERVICE_REQUESTS', 'SERVICE_REQUEST_HISTORY'], defaultTable: 'SERVICE_REQUESTS' },
  system: { code: 'system', label: 'ระบบกลาง', tables: ['AUDIT_LOGS', 'NOTIFICATIONS', 'IMAGE_UPLOADS', 'AUTH_ATTEMPTS'], defaultTable: 'AUDIT_LOGS' }
};

const ROLE_DEFINITIONS = [
  { roleCode: 'SUPER_ADMIN', roleName: 'ผู้ดูแลระบบสูงสุด', description: 'จัดการระบบทุกส่วน', permissions: ['*'] },
  { roleCode: 'ADMIN', roleName: 'ผู้ดูแลระบบ', description: 'ดูแลผู้ใช้และข้อมูลระบบ', permissions: ['*'] },
  { roleCode: 'PRINCIPAL', roleName: 'ผู้อำนวยการ', description: 'ดูภาพรวม อนุมัติ และรายงาน', permissions: ['dashboard:read', 'reports:read', 'analytics:read', 'graduation:read', 'graduation:approve', 'assessment:read', 'assessment:approve', 'registration:read', 'students:read', 'lec:read', 'calendar:read', 'services:read'] },
  { roleCode: 'ACADEMIC_VICE_DIRECTOR', roleName: 'รองผู้อำนวยการฝ่ายวิชาการ', description: 'กำกับดูแลงานวิชาการ', permissions: ['dashboard:read', 'students:read', 'admissions:*', 'curriculum:*', 'registration:*', 'timetable:*', 'attendance:read', 'assessment:*', 'gradeImprovement:*', 'graduation:*', 'analytics:read', 'teachers:read', 'reports:read', 'lec:read', 'calendar:*', 'studentSupport:*', 'services:*'] },
  { roleCode: 'REGISTRAR', roleName: 'เจ้าหน้าที่ทะเบียน', description: 'บริหารทะเบียนและเอกสารนักเรียน', permissions: ['dashboard:read', 'students:*', 'admissions:*', 'curriculum:read', 'registration:*', 'graduation:*', 'reports:read', 'lec:read', 'calendar:read', 'services:*'] },
  { roleCode: 'ASSESSMENT_OFFICER', roleName: 'เจ้าหน้าที่วัดผล', description: 'บริหารคะแนนและผลการเรียน', permissions: ['dashboard:read', 'students:read', 'registration:read', 'attendance:read', 'assessment:*', 'gradeImprovement:*', 'graduation:read', 'analytics:read', 'reports:read', 'calendar:read'] },
  { roleCode: 'DEPARTMENT_HEAD', roleName: 'หัวหน้ากลุ่มสาระ', description: 'ตรวจสอบรายวิชาและผลการเรียนในกลุ่มสาระ', permissions: ['dashboard:read', 'curriculum:read', 'timetable:read', 'attendance:read', 'assessment:read', 'assessment:approve', 'analytics:read', 'teachers:read', 'calendar:read'] },
  { roleCode: 'TEACHER', roleName: 'ครูผู้สอน', description: 'จัดการรายวิชาที่ได้รับมอบหมาย', permissions: ['dashboard:read', 'students:read', 'curriculum:read', 'registration:read', 'timetable:read', 'attendance:read', 'attendance:create', 'attendance:update', 'assessment:read', 'assessment:create', 'assessment:update', 'assessment:submit', 'gradeImprovement:read', 'gradeImprovement:create', 'teachers:read', 'calendar:read', 'portfolio:read', 'portfolio:create', 'portfolio:update', 'studentSupport:read', 'studentSupport:create'] },
  { roleCode: 'ADVISOR', roleName: 'ครูที่ปรึกษา', description: 'ดูแลนักเรียนประจำชั้น', permissions: ['dashboard:read', 'students:read', 'attendance:read', 'analytics:read', 'teachers:read', 'calendar:read', 'studentSupport:*', 'services:read'] },
  { roleCode: 'GUIDANCE', roleName: 'งานแนะแนว', description: 'ดูแลข้อมูลแนะแนวและให้คำปรึกษา', permissions: ['dashboard:read', 'students:read', 'teachers:read', 'studentSupport:*', 'portfolio:read', 'reports:read'] },
  { roleCode: 'STUDENT', roleName: 'นักเรียน', description: 'ดูข้อมูลส่วนบุคคลและผลการเรียนของตนเอง', permissions: ['portal:read', 'students:read', 'registration:read', 'timetable:read', 'attendance:read', 'assessment:read', 'gradeImprovement:read', 'graduation:read', 'calendar:read', 'portfolio:*', 'services:create', 'services:read'] },
  { roleCode: 'PARENT', roleName: 'ผู้ปกครอง', description: 'ดูข้อมูลบุตรหลานตามสิทธิ์', permissions: ['portal:read', 'students:read', 'attendance:read', 'assessment:read', 'graduation:read', 'calendar:read', 'services:create', 'services:read'] },
  { roleCode: 'LOCAL_GOV_REPORTER', roleName: 'เจ้าหน้าที่รายงานต้นสังกัด', description: 'ดูข้อมูลสรุปและรายงานที่ได้รับอนุญาต', permissions: ['dashboard:read', 'reports:read', 'lec:read', 'students:read', 'analytics:read'] }
];

const TABLE_TO_MODULE = {};
Object.keys(ARAMS_MODULES).forEach(function (moduleKey) {
  (ARAMS_MODULES[moduleKey].tables || []).forEach(function (tableName) {
    if (!TABLE_TO_MODULE[tableName]) TABLE_TO_MODULE[tableName] = moduleKey;
  });
});

/* ========================================================================== *
 *  SECTION 04 - INSTALLATION AND DATABASE INITIALIZATION
 * ========================================================================== */

/**
 * Run once from Apps Script editor. Creates the spreadsheet if no ID is set,
 * creates all required sheets, repairs missing headers, and seeds system data.
 */
function initializeAramsDatabase() {
  const lock = LockService.getScriptLock();
  lock.waitLock(ARAMS_CONFIG.LOCK_WAIT_MS);
  try {
    ensureAppSecret_();
    const ss = getDatabaseSpreadsheet_();
    const result = ensureAllSheets_(ss);
    seedDefaultRoles_(ss);
    seedDefaultSettings_(ss);
    seedDefaultSchoolProfile_(ss);
    seedDefaultGradeScale_(ss);
    SpreadsheetApp.flush();
    return {
      success: true,
      message: 'เตรียมฐานข้อมูล ARAMS เรียบร้อยแล้ว',
      spreadsheetId: ss.getId(),
      spreadsheetUrl: ss.getUrl(),
      createdSheets: result.createdSheets,
      repairedSheets: result.repairedSheets,
      totalSheets: Object.keys(ARAMS_SCHEMA).length
    };
  } catch (error) {
    console.error('initializeAramsDatabase: ' + error.stack);
    throw new Error('ไม่สามารถเตรียมฐานข้อมูล ARAMS ได้ กรุณาตรวจสอบการตั้งค่าและลองใหม่');
  } finally {
    lock.releaseLock();
  }
}

/** Create the initial super administrator from Script Properties. */
function bootstrapInitialAdminFromProperties() {
  const props = PropertiesService.getScriptProperties();
  const email = normalizeEmail_(props.getProperty(SCRIPT_PROPERTY_KEYS.INITIAL_ADMIN_EMAIL) || '');
  const password = props.getProperty(SCRIPT_PROPERTY_KEYS.INITIAL_ADMIN_PASSWORD) || '';
  const displayName = String(props.getProperty(SCRIPT_PROPERTY_KEYS.INITIAL_ADMIN_NAME) || 'ผู้ดูแลระบบสูงสุด').trim();

  if (!email || !password) {
    throw new Error('กรุณากำหนด INITIAL_ADMIN_EMAIL และ INITIAL_ADMIN_PASSWORD ใน Script Properties');
  }
  if (password.length < 12) {
    throw new Error('รหัสผ่านเริ่มต้นต้องมีอย่างน้อย 12 ตัวอักษร');
  }

  const ss = getDatabaseSpreadsheet_();
  ensureAllSheets_(ss);
  const users = getSheet_(ss, 'USERS');
  const existing = findRecordByField_(users, 'email', email);
  if (existing) {
    throw new Error('มีบัญชีผู้ใช้นี้อยู่แล้ว ไม่สามารถสร้างบัญชีผู้ดูแลเริ่มต้นซ้ำได้');
  }

  const salt = createRandomToken_();
  const now = nowIso_();
  const user = {
    id: createId_('USR'),
    createdAt: now,
    updatedAt: now,
    createdBy: 'SYSTEM',
    updatedBy: 'SYSTEM',
    status: 'ACTIVE',
    email: email,
    username: email,
    passwordHash: hashPassword_(password, salt),
    passwordSalt: salt,
    displayName: displayName,
    firstName: displayName,
    lastName: '',
    phone: '',
    roleCodes: JSON.stringify(['SUPER_ADMIN']),
    teacherId: '',
    studentId: '',
    guardianId: '',
    lastLoginAt: '',
    passwordChangedAt: now,
    mustChangePassword: 'TRUE',
    failedLoginCount: 0,
    lockedUntil: ''
  };
  appendObject_(users, user);
  appendAuditLog_(null, {
    action: 'BOOTSTRAP_ADMIN', module: 'settings', tableName: 'USERS',
    recordId: user.id, after: sanitizeUser_(user), reason: 'สร้างบัญชีผู้ดูแลระบบเริ่มต้น'
  });

  props.deleteProperty(SCRIPT_PROPERTY_KEYS.INITIAL_ADMIN_PASSWORD);
  props.deleteProperty(SCRIPT_PROPERTY_KEYS.INITIAL_ADMIN_EMAIL);
  props.deleteProperty(SCRIPT_PROPERTY_KEYS.INITIAL_ADMIN_NAME);

  return {
    success: true,
    message: 'สร้างบัญชีผู้ดูแลระบบสูงสุดเรียบร้อยแล้ว',
    userId: user.id,
    email: email,
    instruction: 'เข้าสู่ระบบครั้งแรกและเปลี่ยนรหัสผ่านทันที'
  };
}

/** Set an existing Google Spreadsheet as the ARAMS database. */
function setAramsSpreadsheetId(spreadsheetId) {
  const value = String(spreadsheetId || '').trim();
  if (!value) throw new Error('กรุณาระบุ Spreadsheet ID');
  const ss = SpreadsheetApp.openById(value);
  PropertiesService.getScriptProperties().setProperty(SCRIPT_PROPERTY_KEYS.SPREADSHEET_ID, ss.getId());
  return { success: true, spreadsheetId: ss.getId(), spreadsheetUrl: ss.getUrl() };
}

/** Returns the current database details for an administrator. */
function getAramsDatabaseInfo() {
  const ss = getDatabaseSpreadsheet_();
  return {
    spreadsheetId: ss.getId(),
    spreadsheetUrl: ss.getUrl(),
    sheetCount: ss.getSheets().length,
    schemaSheetCount: Object.keys(ARAMS_SCHEMA).length,
    version: ARAMS_CONFIG.APP_VERSION
  };
}

function ensureAllSheets_(ss) {
  const createdSheets = [];
  const repairedSheets = [];
  Object.keys(ARAMS_SCHEMA).forEach(function (sheetName) {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      createdSheets.push(sheetName);
    }
    const expected = ARAMS_SCHEMA[sheetName];
    const lastColumn = Math.max(sheet.getLastColumn(), 1);
    const existing = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0]
      .map(function (value) { return String(value || '').trim(); });
    const hasAnyHeader = existing.some(function (value) { return value !== ''; });

    if (!hasAnyHeader) {
      sheet.getRange(1, 1, 1, expected.length).setValues([expected]);
      formatHeaderRow_(sheet, expected.length);
      repairedSheets.push(sheetName);
      return;
    }

    const missing = expected.filter(function (header) { return existing.indexOf(header) === -1; });
    if (missing.length) {
      const startColumn = Math.max(sheet.getLastColumn(), 0) + 1;
      sheet.getRange(1, startColumn, 1, missing.length).setValues([missing]);
      repairedSheets.push(sheetName);
    }
    formatHeaderRow_(sheet, Math.max(sheet.getLastColumn(), expected.length));
  });
  return { createdSheets: createdSheets, repairedSheets: repairedSheets };
}

function formatHeaderRow_(sheet, columnCount) {
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, columnCount)
    .setFontWeight('bold')
    .setWrap(true)
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 34);
  try { sheet.getRange(1, 1, sheet.getMaxRows(), columnCount).createFilter(); } catch (ignore) {}
}

function seedDefaultRoles_(ss) {
  const rolesSheet = getSheet_(ss, 'ROLES');
  const permissionSheet = getSheet_(ss, 'ROLE_PERMISSIONS');
  const permissionCatalog = getPermissionCatalog_();
  const existingRoles = getAllObjects_(rolesSheet);
  const roleCodes = existingRoles.map(function (row) { return String(row.roleCode || ''); });
  const existingAssignments = getAllObjects_(permissionSheet);
  const assignmentKeys = {};
  existingAssignments.forEach(function (row) {
    assignmentKeys[String(row.roleCode) + '|' + String(row.permissionCode)] = true;
  });
  const now = nowIso_();

  ROLE_DEFINITIONS.forEach(function (role, index) {
    if (roleCodes.indexOf(role.roleCode) === -1) {
      appendObject_(rolesSheet, {
        id: createId_('ROL'), createdAt: now, updatedAt: now,
        createdBy: 'SYSTEM', updatedBy: 'SYSTEM', status: 'ACTIVE', notes: '',
        roleCode: role.roleCode, roleName: role.roleName,
        description: role.description, isSystemRole: 'TRUE', sortOrder: index + 1
      });
    }
    const rolePerms = role.permissions.indexOf('*') >= 0
      ? ['*']
      : role.permissions.slice();
    rolePerms.forEach(function (permissionCode) {
      const key = role.roleCode + '|' + permissionCode;
      if (!assignmentKeys[key]) {
        appendObject_(permissionSheet, {
          id: createId_('RPER'), createdAt: now, updatedAt: now,
          createdBy: 'SYSTEM', updatedBy: 'SYSTEM', status: 'ACTIVE', notes: '',
          roleCode: role.roleCode, permissionCode: permissionCode, allowed: 'TRUE'
        });
      }
    });
  });

  const permissionData = getAllObjects_(getSheet_(ss, 'PERMISSIONS'));
  const known = {};
  permissionData.forEach(function (row) { known[String(row.permissionCode)] = true; });
  permissionCatalog.forEach(function (item) {
    if (!known[item.permissionCode]) {
      appendObject_(getSheet_(ss, 'PERMISSIONS'), {
        id: createId_('PER'), createdAt: now, updatedAt: now,
        createdBy: 'SYSTEM', updatedBy: 'SYSTEM', status: 'ACTIVE', notes: '',
        permissionCode: item.permissionCode, permissionName: item.permissionName,
        moduleCode: item.moduleCode, actionCode: item.actionCode,
        description: item.description
      });
    }
  });
}

function seedDefaultSettings_(ss) {
  const sheet = getSheet_(ss, 'SYSTEM_SETTINGS');
  const existing = getAllObjects_(sheet);
  const map = {};
  existing.forEach(function (row) { map[String(row.settingKey)] = true; });
  const defaults = [
    ['APP_NAME', 'ARAMS', 'STRING', 'ชื่อระบบ', 'TRUE'],
    ['APP_VERSION', ARAMS_CONFIG.APP_VERSION, 'STRING', 'เวอร์ชันระบบ', 'TRUE'],
    ['TIME_ZONE', ARAMS_CONFIG.TIME_ZONE, 'STRING', 'เขตเวลา', 'TRUE'],
    ['SCHOOL_NAME', ARAMS_CONFIG.DEFAULT_SCHOOL_NAME, 'STRING', 'ชื่อโรงเรียน', 'TRUE'],
    ['CURRENT_ACADEMIC_YEAR', '', 'STRING', 'ปีการศึกษาปัจจุบัน', 'TRUE'],
    ['CURRENT_TERM', '', 'STRING', 'ภาคเรียนปัจจุบัน', 'TRUE'],
    ['DEFAULT_PAGE_SIZE', String(ARAMS_CONFIG.DEFAULT_PAGE_SIZE), 'NUMBER', 'จำนวนรายการต่อหน้า', 'TRUE'],
    ['MAX_IMAGE_BYTES', String(ARAMS_CONFIG.MAX_IMAGE_BYTES), 'NUMBER', 'ขนาดรูปภาพสูงสุด (byte)', 'FALSE']
  ];
  const now = nowIso_();
  defaults.forEach(function (item) {
    if (!map[item[0]]) {
      appendObject_(sheet, {
        id: createId_('SET'), createdAt: now, updatedAt: now,
        createdBy: 'SYSTEM', updatedBy: 'SYSTEM', status: 'ACTIVE', notes: '',
        settingKey: item[0], settingValue: item[1], settingType: item[2],
        description: item[3], isPublic: item[4]
      });
    }
  });
}

function seedDefaultSchoolProfile_(ss) {
  const sheet = getSheet_(ss, 'SCHOOL_PROFILE');
  if (sheet.getLastRow() > 1) return;
  appendObject_(sheet, {
    id: createId_('SCH'), createdAt: nowIso_(), updatedAt: nowIso_(),
    createdBy: 'SYSTEM', updatedBy: 'SYSTEM', status: 'ACTIVE', notes: '',
    schoolCode: '', schoolName: ARAMS_CONFIG.DEFAULT_SCHOOL_NAME,
    schoolNameEn: '', department: 'องค์การบริหารส่วนจังหวัดพัทลุง',
    localAuthority: 'องค์การบริหารส่วนจังหวัดพัทลุง', province: 'พัทลุง',
    district: '', subDistrict: '', address: '', phone: '', email: '', website: '',
    logoUrl: '', academicDirectorName: '', principalName: ''
  });
}

function seedDefaultGradeScale_(ss) {
  const sheet = getSheet_(ss, 'GRADE_SCALE');
  if (sheet.getLastRow() > 1) return;
  const rows = [
    ['4', 80, 100, 4.0], ['3.5', 75, 79, 3.5], ['3', 70, 74, 3.0],
    ['2.5', 65, 69, 2.5], ['2', 60, 64, 2.0], ['1.5', 55, 59, 1.5],
    ['1', 50, 54, 1.0], ['0', 0, 49, 0.0]
  ];
  rows.forEach(function (item, index) {
    appendObject_(sheet, {
      id: createId_('GSC'), createdAt: nowIso_(), updatedAt: nowIso_(),
      createdBy: 'SYSTEM', updatedBy: 'SYSTEM', status: 'ACTIVE', notes: '',
      scaleCode: 'DEFAULT', scaleName: 'เกณฑ์คะแนนเริ่มต้น', curriculumId: '',
      gradeLabel: item[0], minScore: item[1], maxScore: item[2],
      gradePoint: item[3], passStatus: item[0] === '0' ? 'FAIL' : 'PASS',
      sortOrder: index + 1
    });
  });
}

/* ========================================================================== *
 *  SECTION 05 - WEB APP ENTRY POINTS AND API ROUTER
 * ========================================================================== */

function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const action = String(params.action || 'health').trim();
  if (action === 'health' || action === 'ping') {
    return jsonOutput_({
      success: true,
      message: 'ARAMS API พร้อมให้บริการ',
      data: { app: ARAMS_CONFIG.APP_NAME, version: ARAMS_CONFIG.APP_VERSION, timestamp: nowIso_() }
    });
  }
  // JSONP is intentionally limited to health only. Never return private data or
  // perform mutations through a callback/script-tag request.
  return jsonOutput_({ success: false, message: 'ไม่พบรายการที่ต้องการ' });
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '';
    if (!raw) return jsonOutput_({ success: false, message: 'ไม่พบข้อมูลคำขอ' });
    if (raw.length > 8 * 1024 * 1024) {
      return jsonOutput_({ success: false, message: 'ข้อมูลมีขนาดใหญ่เกินไป กรุณาแบ่งรายการแล้วลองใหม่' });
    }
    const request = JSON.parse(raw);
    const result = routeApiRequest_(request, e);
    return jsonOutput_(result);
  } catch (error) {
    console.error('doPost: ' + (error && error.stack ? error.stack : error));
    return jsonOutput_({ success: false, message: 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง' });
  }
}

function routeApiRequest_(request, event) {
  const action = String(request.action || '').trim();
  const data = request.data && typeof request.data === 'object' ? request.data : {};
  const token = String(request.token || '').trim();

  if (!action) return apiError_('กรุณาระบุรายการที่ต้องการ');

  switch (action) {
    case 'auth.login': return apiLogin_(data);
    case 'auth.logout': return apiLogout_(token);
    case 'auth.me': return apiMe_(token);
    case 'auth.changePassword': return apiChangePassword_(token, data);
    case 'admin.users.create': return apiAdminCreateUser_(token, data);
    case 'admin.users.setRoles': return apiAdminSetUserRoles_(token, data);
    case 'admin.users.resetPassword': return apiAdminResetPassword_(token, data);
    case 'admin.users.deactivate': return apiAdminDeactivateUser_(token, data);
    case 'system.status': return apiSystemStatus_();
    case 'system.modules': return apiGetModules_(token);
    case 'system.dashboard': return apiDashboard_(token, data);
    case 'system.options': return apiGetOptions_(token, data);
    case 'system.audit': return apiAuditList_(token, data);
    case 'data.list': return apiDataList_(token, data);
    case 'data.get': return apiDataGet_(token, data);
    case 'data.create': return apiDataCreate_(token, data);
    case 'data.update': return apiDataUpdate_(token, data);
    case 'data.delete': return apiDataDelete_(token, data);
    case 'data.bulkUpsert': return apiDataBulkUpsert_(token, data);
    case 'upload.image': return apiUploadImage_(token, data);
    case 'academic.studentSummary': return apiStudentSummary_(token, data);
    case 'academic.validateRegistration': return apiValidateRegistration_(token, data);
    case 'academic.calculateGrades': return apiCalculateGrades_(token, data);
    case 'academic.checkGraduation': return apiCheckGraduation_(token, data);
    case 'academic.approveGrades': return apiApproveGrades_(token, data);
    case 'admissions.convertToStudent': return apiConvertAdmission_(token, data);
    case 'attendance.summary': return apiAttendanceSummary_(token, data);
    case 'documents.nextNumber': return apiNextDocumentNumber_(token, data);
    case 'reports.exportCsv': return apiExportCsv_(token, data);
    default: return apiError_('ไม่พบรายการที่ต้องการ');
  }
}

function jsonOutput_(object) {
  return ContentService.createTextOutput(JSON.stringify(object))
    .setMimeType(ContentService.MimeType.JSON);
}

function apiError_(message) {
  return { success: false, message: message || 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง' };
}

function apiSuccess_(message, data) {
  return { success: true, message: message || 'ดำเนินการเรียบร้อยแล้ว', data: data === undefined ? null : data };
}

/* ========================================================================== *
 *  SECTION 06 - AUTHENTICATION, SESSIONS, AND PERMISSIONS
 * ========================================================================== */

function apiLogin_(data) {
  const email = normalizeEmail_(data.email || data.username || '');
  const password = String(data.password || '');
  if (!email || !password) return apiError_('กรุณากรอกอีเมลและรหัสผ่าน');

  const attemptKey = 'LOGIN_' + sha256Hex_(email);
  const cache = CacheService.getScriptCache();
  const lockedValue = cache.get(attemptKey);
  if (lockedValue) return apiError_('ไม่สามารถเข้าสู่ระบบได้ในขณะนี้ กรุณาลองใหม่ภายหลัง');

  const ss = getDatabaseSpreadsheet_();
  const user = findRecordByField_(getSheet_(ss, 'USERS'), 'email', email);
  if (!user || String(user.status).toUpperCase() !== 'ACTIVE') {
    recordLoginFailure_(email, attemptKey);
    return apiError_('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  }
  if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
    return apiError_('บัญชีถูกระงับชั่วคราว กรุณาติดต่อผู้ดูแลระบบ');
  }
  const expected = hashPassword_(password, String(user.passwordSalt || ''));
  if (!constantTimeEquals_(expected, String(user.passwordHash || ''))) {
    recordLoginFailure_(email, attemptKey);
    return apiError_('อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  }

  cache.remove(attemptKey);
  cache.remove(attemptKey + '_COUNT');
  const token = createRandomToken_() + createRandomToken_();
  const sessionVersion = getUserSessionVersion_(user.id);
  const userPayload = {
    userId: user.id,
    email: user.email,
    displayName: user.displayName || (String(user.firstName || '') + ' ' + String(user.lastName || '')).trim(),
    roleCodes: parseJsonArray_(user.roleCodes),
    teacherId: user.teacherId || '',
    studentId: user.studentId || '',
    guardianId: user.guardianId || '',
    sessionVersion: sessionVersion,
    mustChangePassword: String(user.mustChangePassword).toUpperCase() === 'TRUE'
  };
  cache.put(sessionCacheKey_(token), JSON.stringify(userPayload), ARAMS_CONFIG.SESSION_TTL_SECONDS);
  updateUserLogin_(user.id);
  appendAuditLog_(userPayload, {
    action: 'LOGIN', module: 'system', tableName: 'USERS', recordId: user.id,
    reason: 'เข้าสู่ระบบ'
  });
  return apiSuccess_('เข้าสู่ระบบเรียบร้อยแล้ว', {
    token: token,
    user: userPayload,
    expiresIn: ARAMS_CONFIG.SESSION_TTL_SECONDS
  });
}

function apiLogout_(token) {
  if (token) CacheService.getScriptCache().remove(sessionCacheKey_(token));
  return apiSuccess_('ออกจากระบบเรียบร้อยแล้ว', null);
}

function apiMe_(token) {
  const user = getSessionUser_(token);
  if (!user) return apiError_('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  return apiSuccess_('ดึงข้อมูลผู้ใช้งานเรียบร้อยแล้ว', { user: user, permissions: getUserPermissions_(user) });
}

function apiChangePassword_(token, data) {
  const user = getSessionUser_(token);
  if (!user) return apiError_('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  const currentPassword = String(data.currentPassword || '');
  const newPassword = String(data.newPassword || '');
  if (newPassword.length < 12) return apiError_('รหัสผ่านใหม่ต้องมีอย่างน้อย 12 ตัวอักษร');
  if (newPassword === currentPassword) return apiError_('กรุณากำหนดรหัสผ่านใหม่ที่ไม่ซ้ำกับรหัสผ่านเดิม');

  const ss = getDatabaseSpreadsheet_();
  const sheet = getSheet_(ss, 'USERS');
  const record = findRecordById_(sheet, user.userId);
  if (!record || hashPassword_(currentPassword, String(record.passwordSalt || '')) !== String(record.passwordHash || '')) {
    return apiError_('รหัสผ่านปัจจุบันไม่ถูกต้อง');
  }
  const salt = createRandomToken_();
  updateRecordById_(sheet, user.userId, {
    passwordSalt: salt,
    passwordHash: hashPassword_(newPassword, salt),
    passwordChangedAt: nowIso_(),
    mustChangePassword: 'FALSE'
  });
  invalidateUserSessions_(user.userId);
  CacheService.getScriptCache().remove(sessionCacheKey_(token));
  appendAuditLog_(user, { action: 'CHANGE_PASSWORD', module: 'settings', tableName: 'USERS', recordId: user.userId });
  return apiSuccess_('เปลี่ยนรหัสผ่านเรียบร้อยแล้ว กรุณาเข้าสู่ระบบอีกครั้ง', null);
}


function apiAdminCreateUser_(token, data) {
  try {
    const actor = requirePermission_(token, 'settings', 'create');
    const email = normalizeEmail_(data.email || '');
    const password = String(data.password || '');
    const displayName = String(data.displayName || '').trim();
    const roleCodes = Array.isArray(data.roleCodes) ? data.roleCodes : [String(data.roleCode || 'TEACHER')];
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return apiError_('กรุณาระบุอีเมลให้ถูกต้อง');
    if (password.length < 12) return apiError_('รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร');
    if (!displayName) return apiError_('กรุณาระบุชื่อผู้ใช้งาน');
    if (!roleCodes.length) return apiError_('กรุณากำหนดบทบาทผู้ใช้งาน');

    const ss = getDatabaseSpreadsheet_();
    const usersSheet = getSheet_(ss, 'USERS');
    const lock = LockService.getScriptLock();
    lock.waitLock(ARAMS_CONFIG.LOCK_WAIT_MS);
    try {
      if (findRecordByField_(usersSheet, 'email', email)) return apiError_('อีเมลนี้มีอยู่ในระบบแล้ว');
      const validRoles = getAllObjects_(getSheet_(ss, 'ROLES')).map(function (row) { return String(row.roleCode); });
      const uniqueRoles = Array.from(new Set(roleCodes.map(String)));
      for (let i = 0; i < uniqueRoles.length; i++) {
        if (validRoles.indexOf(uniqueRoles[i]) < 0) return apiError_('พบบทบาทผู้ใช้งานที่ไม่ถูกต้อง');
      }
      if (uniqueRoles.indexOf('SUPER_ADMIN') >= 0 && actor.roleCodes.indexOf('SUPER_ADMIN') < 0) {
        return apiError_('เฉพาะผู้ดูแลระบบสูงสุดเท่านั้นที่สามารถกำหนดสิทธิ์นี้ได้');
      }

      const salt = createRandomToken_();
      const userRecord = Object.assign(baseRecord_(actor.userId), {
        email: email,
        username: email,
        passwordHash: hashPassword_(password, salt),
        passwordSalt: salt,
        displayName: displayName,
        firstName: String(data.firstName || displayName),
        lastName: String(data.lastName || ''),
        phone: String(data.phone || ''),
        roleCodes: JSON.stringify(uniqueRoles),
        teacherId: String(data.teacherId || ''),
        studentId: String(data.studentId || ''),
        guardianId: String(data.guardianId || ''),
        lastLoginAt: '',
        passwordChangedAt: nowIso_(),
        mustChangePassword: 'TRUE',
        failedLoginCount: 0,
        lockedUntil: ''
      });
      appendObject_(usersSheet, userRecord);
      appendAuditLog_(actor, {
        action: 'CREATE_USER', module: 'settings', tableName: 'USERS',
        recordId: userRecord.id,
        after: { email: email, displayName: displayName, roleCodes: uniqueRoles }
      });
      return apiSuccess_('สร้างบัญชีผู้ใช้งานเรียบร้อยแล้ว', {
        id: userRecord.id, email: email, displayName: displayName,
        roleCodes: uniqueRoles, mustChangePassword: true
      });
    } finally { lock.releaseLock(); }
  } catch (error) { return mapApiError_(error); }
}

function apiAdminSetUserRoles_(token, data) {
  try {
    const actor = requirePermission_(token, 'settings', 'update');
    const userId = String(data.userId || '').trim();
    const roleCodes = Array.isArray(data.roleCodes) ? Array.from(new Set(data.roleCodes.map(String))) : [];
    if (!userId || !roleCodes.length) return apiError_('กรุณาระบุบัญชีและบทบาทที่ต้องการกำหนด');
    const ss = getDatabaseSpreadsheet_();
    const usersSheet = getSheet_(ss, 'USERS');
    const target = findRecordById_(usersSheet, userId);
    if (!target) return apiError_('ไม่พบบัญชีผู้ใช้งาน');
    if (String(target.id) === String(actor.userId) && roleCodes.indexOf('SUPER_ADMIN') < 0) {
      return apiError_('ไม่สามารถถอดสิทธิ์ผู้ดูแลระบบสูงสุดออกจากบัญชีที่กำลังใช้งานได้');
    }
    const targetRoles = parseJsonArray_(target.roleCodes);
    if (targetRoles.indexOf('SUPER_ADMIN') >= 0 && roleCodes.indexOf('SUPER_ADMIN') < 0) {
      const activeSuperAdmins = getAllObjects_(usersSheet).filter(function (row) {
        return String(row.status).toUpperCase() === 'ACTIVE' && parseJsonArray_(row.roleCodes).indexOf('SUPER_ADMIN') >= 0;
      });
      if (activeSuperAdmins.length <= 1) return apiError_('ต้องมีผู้ดูแลระบบสูงสุดอย่างน้อยหนึ่งบัญชี');
    }
    const validRoles = getAllObjects_(getSheet_(ss, 'ROLES')).map(function (row) { return String(row.roleCode); });
    if (roleCodes.some(function (role) { return validRoles.indexOf(role) < 0; })) return apiError_('พบบทบาทผู้ใช้งานที่ไม่ถูกต้อง');
    if (roleCodes.indexOf('SUPER_ADMIN') >= 0 && actor.roleCodes.indexOf('SUPER_ADMIN') < 0) {
      return apiError_('เฉพาะผู้ดูแลระบบสูงสุดเท่านั้นที่สามารถกำหนดสิทธิ์นี้ได้');
    }
    updateRecordById_(usersSheet, userId, {
      roleCodes: JSON.stringify(roleCodes), updatedAt: nowIso_(), updatedBy: actor.userId
    });
    invalidateUserSessions_(userId);
    appendAuditLog_(actor, {
      action: 'SET_USER_ROLES', module: 'settings', tableName: 'USERS',
      recordId: userId, before: { roleCodes: parseJsonArray_(target.roleCodes) },
      after: { roleCodes: roleCodes }
    });
    return apiSuccess_('กำหนดสิทธิ์ผู้ใช้งานเรียบร้อยแล้ว', { userId: userId, roleCodes: roleCodes });
  } catch (error) { return mapApiError_(error); }
}

function apiAdminResetPassword_(token, data) {
  try {
    const actor = requirePermission_(token, 'settings', 'update');
    const userId = String(data.userId || '').trim();
    const newPassword = String(data.newPassword || '');
    if (!userId || newPassword.length < 12) return apiError_('กรุณาระบุบัญชีและรหัสผ่านใหม่อย่างน้อย 12 ตัวอักษร');
    const sheet = getSheet_(getDatabaseSpreadsheet_(), 'USERS');
    const target = findRecordById_(sheet, userId);
    if (!target) return apiError_('ไม่พบบัญชีผู้ใช้งาน');
    const salt = createRandomToken_();
    updateRecordById_(sheet, userId, {
      passwordSalt: salt,
      passwordHash: hashPassword_(newPassword, salt),
      passwordChangedAt: nowIso_(),
      mustChangePassword: 'TRUE',
      failedLoginCount: 0,
      lockedUntil: '',
      updatedAt: nowIso_(),
      updatedBy: actor.userId
    });
    invalidateUserSessions_(userId);
    appendAuditLog_(actor, { action: 'RESET_USER_PASSWORD', module: 'settings', tableName: 'USERS', recordId: userId });
    return apiSuccess_('ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว ผู้ใช้งานต้องเปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบ', { userId: userId });
  } catch (error) { return mapApiError_(error); }
}

function apiAdminDeactivateUser_(token, data) {
  try {
    const actor = requirePermission_(token, 'settings', 'update');
    const userId = String(data.userId || '').trim();
    if (!userId) return apiError_('กรุณาเลือกบัญชีผู้ใช้งาน');
    if (userId === actor.userId) return apiError_('ไม่สามารถปิดใช้งานบัญชีที่กำลังเข้าสู่ระบบได้');
    const sheet = getSheet_(getDatabaseSpreadsheet_(), 'USERS');
    const target = findRecordById_(sheet, userId);
    if (!target) return apiError_('ไม่พบบัญชีผู้ใช้งาน');
    if (parseJsonArray_(target.roleCodes).indexOf('SUPER_ADMIN') >= 0) return apiError_('ไม่สามารถปิดใช้งานบัญชีผู้ดูแลระบบสูงสุดได้');
    updateRecordById_(sheet, userId, {
      status: 'INACTIVE', updatedAt: nowIso_(), updatedBy: actor.userId,
      notes: String(data.reason || 'ปิดใช้งานบัญชีโดยผู้ดูแลระบบ')
    });
    invalidateUserSessions_(userId);
    appendAuditLog_(actor, { action: 'DEACTIVATE_USER', module: 'settings', tableName: 'USERS', recordId: userId, reason: String(data.reason || '') });
    return apiSuccess_('ปิดใช้งานบัญชีเรียบร้อยแล้ว', { userId: userId });
  } catch (error) { return mapApiError_(error); }
}

function getSessionUser_(token) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get(sessionCacheKey_(token));
  if (!raw) return null;
  try {
    const user = JSON.parse(raw);
    const currentVersion = cache.get(userSessionVersionKey_(user.userId));
    if (!currentVersion || currentVersion !== user.sessionVersion) {
      cache.remove(sessionCacheKey_(token));
      return null;
    }
    return user;
  } catch (ignore) { return null; }
}

function userSessionVersionKey_(userId) {
  return 'USER_SESSION_VERSION_' + String(userId);
}

function getUserSessionVersion_(userId) {
  const cache = CacheService.getScriptCache();
  const key = userSessionVersionKey_(userId);
  let version = cache.get(key);
  if (!version) {
    version = createRandomToken_();
    cache.put(key, version, ARAMS_CONFIG.SESSION_TTL_SECONDS);
  }
  return version;
}

function invalidateUserSessions_(userId) {
  CacheService.getScriptCache().put(userSessionVersionKey_(userId), createRandomToken_(), ARAMS_CONFIG.SESSION_TTL_SECONDS);
}

function sessionCacheKey_(token) {
  return 'SESSION_' + sha256Hex_(String(token));
}

function requirePermission_(token, moduleCode, actionCode) {
  const user = getSessionUser_(token);
  if (!user) throw new Error('SESSION_EXPIRED');
  if (user.mustChangePassword) throw new Error('PASSWORD_CHANGE_REQUIRED');
  if (!hasPermission_(user, moduleCode, actionCode)) throw new Error('PERMISSION_DENIED');
  return user;
}

function hasPermission_(user, moduleCode, actionCode) {
  const roleCodes = user && user.roleCodes ? user.roleCodes : [];
  if (roleCodes.indexOf('SUPER_ADMIN') >= 0 || roleCodes.indexOf('ADMIN') >= 0) return true;
  const rows = getPermissionRowsCached_();
  const wantedExact = moduleCode + ':' + actionCode;
  const wantedModuleWildcard = moduleCode + ':*';
  return rows.some(function (row) {
    if (roleCodes.indexOf(String(row.roleCode)) === -1) return false;
    if (String(row.allowed).toUpperCase() !== 'TRUE') return false;
    const permission = String(row.permissionCode || '');
    return permission === '*' || permission === wantedExact || permission === wantedModuleWildcard;
  });
}

function getUserPermissions_(user) {
  if (!user) return [];
  if (user.roleCodes.indexOf('SUPER_ADMIN') >= 0 || user.roleCodes.indexOf('ADMIN') >= 0) return ['*'];
  const rows = getPermissionRowsCached_();
  return rows.filter(function (row) {
    return user.roleCodes.indexOf(String(row.roleCode)) >= 0 && String(row.allowed).toUpperCase() === 'TRUE';
  }).map(function (row) { return String(row.permissionCode); });
}

function getPermissionRowsCached_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('ARAMS_ROLE_PERMISSION_CACHE_V1');
  if (cached) {
    try { return JSON.parse(cached); } catch (ignore) {}
  }
  const rows = getAllObjects_(getSheet_(getDatabaseSpreadsheet_(), 'ROLE_PERMISSIONS'));
  try { cache.put('ARAMS_ROLE_PERMISSION_CACHE_V1', JSON.stringify(rows), 300); } catch (ignore) {}
  return rows;
}

function clearAramsPermissionCache_() {
  CacheService.getScriptCache().remove('ARAMS_ROLE_PERMISSION_CACHE_V1');
}

function recordLoginFailure_(email, cacheKey) {
  const cache = CacheService.getScriptCache();
  const current = Number(cache.get(cacheKey + '_COUNT') || 0) + 1;
  cache.put(cacheKey + '_COUNT', String(current), ARAMS_CONFIG.LOGIN_LOCK_SECONDS);
  if (current >= ARAMS_CONFIG.LOGIN_MAX_ATTEMPTS) {
    cache.put(cacheKey, 'LOCKED', ARAMS_CONFIG.LOGIN_LOCK_SECONDS);
    cache.remove(cacheKey + '_COUNT');
  }
  try {
    const sheet = getSheet_(getDatabaseSpreadsheet_(), 'AUTH_ATTEMPTS');
    const key = sha256Hex_(email);
    const existing = findRecordByField_(sheet, 'emailKey', key);
    const patch = { attemptCount: current, lastAttemptAt: nowIso_(), lockedUntil: current >= ARAMS_CONFIG.LOGIN_MAX_ATTEMPTS ? new Date(Date.now() + ARAMS_CONFIG.LOGIN_LOCK_SECONDS * 1000).toISOString() : '' };
    if (existing) updateRecordById_(sheet, existing.id, patch);
    else appendObject_(sheet, Object.assign(baseRecord_('SYSTEM'), { emailKey: key }, patch));
  } catch (ignore) {}
}

function updateUserLogin_(userId) {
  try {
    updateRecordById_(getSheet_(getDatabaseSpreadsheet_(), 'USERS'), userId, {
      lastLoginAt: nowIso_(), failedLoginCount: 0, lockedUntil: ''
    });
  } catch (error) { console.error('updateUserLogin: ' + error); }
}

/* ========================================================================== *
 *  SECTION 07 - GENERIC DATA API (LIST / GET / CREATE / UPDATE / DELETE)
 * ========================================================================== */

function apiDataList_(token, data) {
  try {
    const moduleInfo = resolveModuleAndTable_(data);
    const user = requirePermission_(token, moduleInfo.moduleCode, 'read');
    const requestedPage = parseInt(data.page, 10);
    const requestedPageSize = parseInt(data.pageSize, 10);
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const pageSize = Number.isFinite(requestedPageSize) && requestedPageSize > 0
      ? Math.min(ARAMS_CONFIG.MAX_PAGE_SIZE, requestedPageSize)
      : ARAMS_CONFIG.DEFAULT_PAGE_SIZE;
    const query = String(data.q || '').trim().slice(0, ARAMS_CONFIG.MAX_SEARCH_LENGTH).toLowerCase();
    const sortBy = String(data.sortBy || 'updatedAt');
    const sortDir = String(data.sortDir || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const includeDeleted = Boolean(data.includeDeleted) && hasPermission_(user, 'settings', 'read');
    const ss = getDatabaseSpreadsheet_();
    const sheet = getSheet_(ss, moduleInfo.tableName);
    const rows = getAllObjects_(sheet);
    const headers = getHeaders_(sheet);
    const visibilityContext = buildVisibilityContext_(user);
    const allowedSort = headers.indexOf(sortBy) >= 0 ? sortBy : 'updatedAt';
    const filtered = rows.filter(function (row) {
      if (!includeDeleted && String(row.status || '').toUpperCase() === ARAMS_CONFIG.SOFT_DELETE_STATUS) return false;
      if (!matchesFilters_(row, data.filters || {})) return false;
      if (query && !matchesQuery_(row, query, data.searchFields || [])) return false;
      if (!isRecordVisibleToUser_(row, moduleInfo.tableName, user, visibilityContext)) return false;
      return true;
    });
    filtered.sort(function (a, b) {
      const av = a[allowedSort] === undefined ? '' : a[allowedSort];
      const bv = b[allowedSort] === undefined ? '' : b[allowedSort];
      const an = Number(av); const bn = Number(bv);
      if (av !== '' && bv !== '' && !isNaN(an) && !isNaN(bn)) return (an - bn) * sortDir;
      return String(av).localeCompare(String(bv), 'th') * sortDir;
    });
    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const records = filtered.slice(start, start + pageSize).map(function (row) {
      return sanitizeRecordForClient_(row, moduleInfo.tableName, user);
    });
    return apiSuccess_('ดึงข้อมูลเรียบร้อยแล้ว', {
      records: records,
      pagination: {
        page: page, pageSize: pageSize, total: total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        hasNext: start + pageSize < total,
        hasPrevious: page > 1
      },
      module: moduleInfo.moduleCode,
      table: moduleInfo.tableName
    });
  } catch (error) {
    return mapApiError_(error);
  }
}

function apiDataGet_(token, data) {
  try {
    const moduleInfo = resolveModuleAndTable_(data);
    const user = requirePermission_(token, moduleInfo.moduleCode, 'read');
    const id = String(data.id || '').trim();
    if (!id) return apiError_('ไม่พบรหัสรายการที่ต้องการ');
    const record = findRecordById_(getSheet_(getDatabaseSpreadsheet_(), moduleInfo.tableName), id);
    if (!record || String(record.status).toUpperCase() === ARAMS_CONFIG.SOFT_DELETE_STATUS) return apiError_('ไม่พบข้อมูลที่ต้องการ');
    if (!isRecordVisibleToUser_(record, moduleInfo.tableName, user)) return apiError_('ไม่มีสิทธิ์เข้าถึงข้อมูลนี้');
    return apiSuccess_('ดึงข้อมูลเรียบร้อยแล้ว', sanitizeRecordForClient_(record, moduleInfo.tableName, user));
  } catch (error) { return mapApiError_(error); }
}

function apiDataCreate_(token, data) {
  try {
    const moduleInfo = resolveModuleAndTable_(data);
    const user = requirePermission_(token, moduleInfo.moduleCode, 'create');
    const record = data.record && typeof data.record === 'object' ? data.record : null;
    if (!record) return apiError_('กรุณาระบุข้อมูลที่ต้องการบันทึก');
    validateRecord_(moduleInfo.tableName, record, 'create');
    if (!canCreateRecordForUser_(record, moduleInfo.tableName, user)) return apiError_('ไม่มีสิทธิ์บันทึกข้อมูลรายการนี้');
    const ss = getDatabaseSpreadsheet_();
    const sheet = getSheet_(ss, moduleInfo.tableName);
    const lock = LockService.getScriptLock();
    lock.waitLock(ARAMS_CONFIG.LOCK_WAIT_MS);
    let created;
    try {
      const payload = prepareRecordForWrite_(moduleInfo.tableName, record, user);
      created = Object.assign(baseRecord_(user.userId), payload);
      created.id = created.id || createId_(moduleInfo.tableName.substring(0, 3));
      checkUniqueConstraints_(sheet, moduleInfo.tableName, created, 'create');
      appendObject_(sheet, created);
      CacheService.getScriptCache().removeAll(['ARAMS_DASHBOARD_' + sha256Hex_(String(getSettingValue_('CURRENT_ACADEMIC_YEAR') || '') + '|' + String(getSettingValue_('CURRENT_TERM') || ''))]);
      if (moduleInfo.tableName === 'ROLE_PERMISSIONS') clearAramsPermissionCache_();
      if (isVisibilitySourceTable_(moduleInfo.tableName)) invalidateVisibilityScopeCache_();
      invalidateDashboardCache_();
      appendAuditLog_(user, {
        action: 'CREATE', module: moduleInfo.moduleCode, tableName: moduleInfo.tableName,
        recordId: created.id, after: auditSafeRecord_(created)
      });
    } finally { lock.releaseLock(); }
    return apiSuccess_('บันทึกข้อมูลเรียบร้อยแล้ว', sanitizeRecordForClient_(created, moduleInfo.tableName, user));
  } catch (error) { return mapApiError_(error); }
}

function apiDataUpdate_(token, data) {
  try {
    const moduleInfo = resolveModuleAndTable_(data);
    const user = requirePermission_(token, moduleInfo.moduleCode, 'update');
    const id = String(data.id || '').trim();
    const patch = data.record && typeof data.record === 'object' ? data.record : null;
    if (!id || !patch) return apiError_('ข้อมูลสำหรับแก้ไขไม่ครบถ้วน');
    const ss = getDatabaseSpreadsheet_();
    const sheet = getSheet_(ss, moduleInfo.tableName);
    const lock = LockService.getScriptLock();
    lock.waitLock(ARAMS_CONFIG.LOCK_WAIT_MS);
    let before; let after;
    try {
      before = findRecordById_(sheet, id);
      if (!before || String(before.status).toUpperCase() === ARAMS_CONFIG.SOFT_DELETE_STATUS) return apiError_('ไม่พบข้อมูลที่ต้องการแก้ไข');
      if (!isRecordVisibleToUser_(before, moduleInfo.tableName, user)) return apiError_('ไม่มีสิทธิ์แก้ไขข้อมูลนี้');
      validateRecord_(moduleInfo.tableName, patch, 'update');
      if (!canUpdateRecordForUser_(before, patch, moduleInfo.tableName, user)) return apiError_('ไม่มีสิทธิ์แก้ไขข้อมูลรายการนี้');
      const payload = prepareRecordForWrite_(moduleInfo.tableName, patch, user);
      delete payload.id;
      delete payload.createdAt;
      delete payload.createdBy;
      payload.updatedAt = nowIso_();
      payload.updatedBy = user.userId;
      checkUniqueConstraints_(sheet, moduleInfo.tableName, Object.assign({}, before, payload), 'update', id);
      updateRecordById_(sheet, id, payload);
      CacheService.getScriptCache().removeAll(['ARAMS_DASHBOARD_' + sha256Hex_(String(getSettingValue_('CURRENT_ACADEMIC_YEAR') || '') + '|' + String(getSettingValue_('CURRENT_TERM') || ''))]);
      if (moduleInfo.tableName === 'ROLE_PERMISSIONS') clearAramsPermissionCache_();
      if (isVisibilitySourceTable_(moduleInfo.tableName)) invalidateVisibilityScopeCache_();
      invalidateDashboardCache_();
      after = Object.assign({}, before, payload);
      appendAuditLog_(user, {
        action: 'UPDATE', module: moduleInfo.moduleCode, tableName: moduleInfo.tableName,
        recordId: id, before: auditSafeRecord_(before), after: auditSafeRecord_(after),
        reason: String(data.reason || '')
      });
    } finally { lock.releaseLock(); }
    return apiSuccess_('แก้ไขข้อมูลเรียบร้อยแล้ว', sanitizeRecordForClient_(after, moduleInfo.tableName, user));
  } catch (error) { return mapApiError_(error); }
}

function apiDataDelete_(token, data) {
  try {
    const moduleInfo = resolveModuleAndTable_(data);
    const user = requirePermission_(token, moduleInfo.moduleCode, 'delete');
    if (moduleInfo.tableName === 'USERS') return apiError_('กรุณาใช้เมนูจัดการบัญชีผู้ใช้งาน');
    const id = String(data.id || '').trim();
    if (!id) return apiError_('ไม่พบรหัสรายการที่ต้องการ');
    const sheet = getSheet_(getDatabaseSpreadsheet_(), moduleInfo.tableName);
    const lock = LockService.getScriptLock();
    lock.waitLock(ARAMS_CONFIG.LOCK_WAIT_MS);
    try {
      const before = findRecordById_(sheet, id);
      if (!before || String(before.status).toUpperCase() === ARAMS_CONFIG.SOFT_DELETE_STATUS) return apiError_('ไม่พบข้อมูลที่ต้องการลบ');
      if (!isRecordVisibleToUser_(before, moduleInfo.tableName, user)) return apiError_('ไม่มีสิทธิ์ลบข้อมูลนี้');
      updateRecordById_(sheet, id, {
        status: ARAMS_CONFIG.SOFT_DELETE_STATUS,
        deletedAt: nowIso_(), deletedBy: user.userId,
        deletionReason: String(data.reason || 'ลบรายการโดยผู้ใช้งาน')
      });
      if (moduleInfo.tableName === 'ROLE_PERMISSIONS') clearAramsPermissionCache_();
      if (isVisibilitySourceTable_(moduleInfo.tableName)) invalidateVisibilityScopeCache_();
      invalidateDashboardCache_();
      appendAuditLog_(user, {
        action: 'SOFT_DELETE', module: moduleInfo.moduleCode,
        tableName: moduleInfo.tableName, recordId: id,
        before: auditSafeRecord_(before), reason: String(data.reason || '')
      });
    } finally { lock.releaseLock(); }
    return apiSuccess_('ลบรายการเรียบร้อยแล้ว', { id: id, deleted: true });
  } catch (error) { return mapApiError_(error); }
}

function apiDataBulkUpsert_(token, data) {
  try {
    const moduleInfo = resolveModuleAndTable_(data);
    const user = requirePermission_(token, moduleInfo.moduleCode, 'create');
    const records = Array.isArray(data.records) ? data.records : [];
    if (!records.length) return apiError_('ไม่พบรายการข้อมูลสำหรับนำเข้า');
    if (records.length > ARAMS_CONFIG.MAX_BULK_ROWS) return apiError_('นำเข้าได้ไม่เกิน ' + ARAMS_CONFIG.MAX_BULK_ROWS + ' รายการต่อครั้ง');
    const uniqueField = String(data.uniqueField || 'id');
    const sheet = getSheet_(getDatabaseSpreadsheet_(), moduleInfo.tableName);
    const headers = getHeaders_(sheet);
    if (headers.indexOf(uniqueField) < 0) return apiError_('ไม่พบฟิลด์สำหรับตรวจสอบข้อมูลซ้ำ');
    const lock = LockService.getScriptLock();
    lock.waitLock(ARAMS_CONFIG.LOCK_WAIT_MS);
    let inserted = 0; let updated = 0; let skipped = 0;
    try {
      const existing = getAllObjects_(sheet);
      const index = {};
      existing.forEach(function (row) { index[String(row[uniqueField])] = row; });
      records.forEach(function (source) {
        if (!source || typeof source !== 'object') { skipped++; return; }
        const payload = prepareRecordForWrite_(moduleInfo.tableName, source, user);
        const uniqueValue = String(payload[uniqueField] || '').trim();
        if (uniqueValue && index[uniqueValue]) {
          const old = index[uniqueValue];
          if (String(old.status).toUpperCase() === ARAMS_CONFIG.SOFT_DELETE_STATUS ||
              !hasPermission_(user, moduleInfo.moduleCode, 'update')) { skipped++; return; }
          validateRecord_(moduleInfo.tableName, source, 'update');
          if (!isRecordVisibleToUser_(old, moduleInfo.tableName, user) ||
              !canUpdateRecordForUser_(old, payload, moduleInfo.tableName, user)) { skipped++; return; }
          const patch = Object.assign({}, payload, { updatedAt: nowIso_(), updatedBy: user.userId });
          delete patch.id; delete patch.createdAt; delete patch.createdBy;
          updateRecordById_(sheet, old.id, patch);
          index[uniqueValue] = Object.assign({}, old, patch);
          updated++;
        } else {
          validateRecord_(moduleInfo.tableName, source, 'create');
          if (!canCreateRecordForUser_(source, moduleInfo.tableName, user)) { skipped++; return; }
          const created = Object.assign(baseRecord_(user.userId), payload);
          created.id = created.id || createId_(moduleInfo.tableName.substring(0, 3));
          checkUniqueConstraints_(sheet, moduleInfo.tableName, created, 'create');
          appendObject_(sheet, created);
          if (uniqueValue) index[uniqueValue] = created;
          inserted++;
        }
      });
      if (isVisibilitySourceTable_(moduleInfo.tableName)) invalidateVisibilityScopeCache_();
      if (moduleInfo.tableName === 'ROLE_PERMISSIONS') clearAramsPermissionCache_();
      invalidateDashboardCache_();
      appendAuditLog_(user, {
        action: 'BULK_UPSERT', module: moduleInfo.moduleCode,
        tableName: moduleInfo.tableName, reason: 'inserted=' + inserted + ';updated=' + updated + ';skipped=' + skipped
      });
    } finally { lock.releaseLock(); }
    return apiSuccess_('นำเข้าข้อมูลเรียบร้อยแล้ว', { inserted: inserted, updated: updated, skipped: skipped });
  } catch (error) { return mapApiError_(error); }
}

/* ========================================================================== *
 *  SECTION 08 - IMAGE UPLOAD API (LOCAL FILE -> APPS SCRIPT -> IMGBB)
 * ========================================================================== */

function apiUploadImage_(token, data) {
  try {
    const uploadModule = String(data.module || 'students');
    const user = getSessionUser_(token);
    if (!user) return apiError_('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    if (!hasPermission_(user, uploadModule, 'create') && !hasPermission_(user, uploadModule, 'update')) {
      return apiError_('คุณไม่มีสิทธิ์อัปโหลดรูปภาพในรายการนี้');
    }
    const fileName = sanitizeFileName_(data.fileName || 'aram-image');
    const mimeType = String(data.mimeType || '').toLowerCase();
    let base64 = String(data.base64 || '');
    base64 = base64.replace(/^data:[^;]+;base64,/i, '').replace(/\s/g, '');

    if (ARAMS_CONFIG.ALLOWED_IMAGE_MIME_TYPES.indexOf(mimeType) < 0) {
      return apiError_('รองรับเฉพาะไฟล์ JPG, PNG และ WEBP');
    }
    if (!base64) return apiError_('กรุณาเลือกไฟล์รูปภาพ');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return apiError_('ไฟล์รูปภาพไม่ถูกต้อง กรุณาเลือกไฟล์ใหม่');
    if (!isImageSignatureValid_(base64, mimeType)) return apiError_('ชนิดไฟล์รูปภาพไม่ถูกต้อง กรุณาเลือกรูปภาพใหม่');
    const estimatedBytes = Math.floor(base64.length * 3 / 4);
    if (estimatedBytes > ARAMS_CONFIG.MAX_IMAGE_BYTES) {
      return apiError_('รูปภาพมีขนาดใหญ่เกิน 5 MB กรุณาเลือกรูปภาพที่มีขนาดเล็กลง');
    }
    const apiKey = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTY_KEYS.IMGBB_API_KEY);
    if (!apiKey) return apiError_('ระบบอัปโหลดรูปภาพยังไม่ได้ตั้งค่า กรุณาติดต่อผู้ดูแลระบบ');

    const response = UrlFetchApp.fetch(ARAMS_CONFIG.IMGBB_UPLOAD_URL, {
      method: 'post',
      payload: {
        key: apiKey,
        image: base64,
        name: fileName.replace(/\.[^.]+$/, '')
      },
      muteHttpExceptions: true,
      followRedirects: true
    });
    const statusCode = response.getResponseCode();
    let responseJson;
    try { responseJson = JSON.parse(response.getContentText()); }
    catch (parseError) { return apiError_('อัปโหลดรูปภาพไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'); }

    if (statusCode < 200 || statusCode >= 300 || !responseJson.success || !responseJson.data) {
      console.error('ImgBB upload failed. HTTP ' + statusCode + ' response=' + response.getContentText().slice(0, 1000));
      return apiError_('อัปโหลดรูปภาพไม่สำเร็จ กรุณาตรวจสอบไฟล์แล้วลองใหม่');
    }

    const imageData = responseJson.data;
    const imageUrl = String(imageData.url || imageData.display_url || '');
    if (!imageUrl) return apiError_('อัปโหลดรูปภาพไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');

    const ss = getDatabaseSpreadsheet_();
    const imageRecord = Object.assign(baseRecord_(user.userId), {
      ownerModule: String(data.module || ''),
      ownerRecordId: String(data.recordId || ''),
      fileName: fileName,
      mimeType: mimeType,
      fileSize: estimatedBytes,
      imageUrl: imageUrl,
      displayUrl: String(imageData.display_url || imageUrl),
      deleteUrl: String(responseJson.data.delete_url || ''),
      imageId: String(imageData.id || ''),
      uploadedBy: user.userId,
      uploadedAt: nowIso_()
    });
    appendObject_(getSheet_(ss, 'IMAGE_UPLOADS'), imageRecord);
    appendAuditLog_(user, {
      action: 'UPLOAD_IMAGE', module: String(data.module || 'system'),
      tableName: 'IMAGE_UPLOADS', recordId: imageRecord.id,
      after: { fileName: fileName, mimeType: mimeType, fileSize: estimatedBytes, imageUrl: imageUrl }
    });
    return apiSuccess_('อัปโหลดรูปภาพเรียบร้อยแล้ว', {
      id: imageRecord.id,
      url: imageUrl,
      displayUrl: imageRecord.displayUrl,
      fileName: fileName,
      mimeType: mimeType,
      fileSize: estimatedBytes
    });
  } catch (error) { return mapApiError_(error); }
}

/* ========================================================================== *
 *  SECTION 09 - ACADEMIC WORKFLOW APIs
 * ========================================================================== */

function apiDashboard_(token, data) {
  try {
    const user = requirePermission_(token, 'dashboard', 'read');
    const ss = getDatabaseSpreadsheet_();
    const academicYear = String(data.academicYear || getSettingValue_('CURRENT_ACADEMIC_YEAR') || '');
    const termCode = String(data.termCode || getSettingValue_('CURRENT_TERM') || '');
    const dashboardRevision = PropertiesService.getScriptProperties().getProperty('ARAMS_DASHBOARD_CACHE_VERSION') || '1';
    const dashboardCacheKey = 'ARAMS_DASHBOARD_' + dashboardRevision + '_' + sha256Hex_(academicYear + '|' + termCode);
    const dashboardCached = CacheService.getScriptCache().get(dashboardCacheKey);
    if (dashboardCached) {
      try { return apiSuccess_('ดึงภาพรวมเรียบร้อยแล้ว', JSON.parse(dashboardCached)); } catch (ignore) {}
    }
    const students = getAllObjects_(getSheet_(ss, 'STUDENTS')).filter(function (row) {
      return String(row.status).toUpperCase() !== ARAMS_CONFIG.SOFT_DELETE_STATUS &&
        String(row.studentStatus || ARAMS_CONFIG.ACTIVE_STATUS).toUpperCase() === 'ACTIVE';
    });
    const teachers = getAllObjects_(getSheet_(ss, 'TEACHERS')).filter(function (row) {
      return String(row.status).toUpperCase() !== ARAMS_CONFIG.SOFT_DELETE_STATUS &&
        String(row.isActive || ARAMS_CONFIG.ACTIVE_STATUS).toUpperCase() !== 'FALSE';
    });
    const grades = getAllObjects_(getSheet_(ss, 'GRADE_RESULTS')).filter(function (row) {
      return (!academicYear || String(row.academicYear) === academicYear) &&
        (!termCode || String(row.termCode) === termCode) &&
        String(row.status).toUpperCase() !== ARAMS_CONFIG.SOFT_DELETE_STATUS;
    });
    const attendance = getAllObjects_(getSheet_(ss, 'ATTENDANCE')).filter(function (row) {
      return (!academicYear || String(row.academicYear) === academicYear) &&
        (!termCode || String(row.termCode) === termCode) &&
        String(row.status).toUpperCase() !== ARAMS_CONFIG.SOFT_DELETE_STATUS;
    });
    const admissions = getAllObjects_(getSheet_(ss, 'ADMISSIONS')).filter(function (row) {
      return (!academicYear || String(row.academicYear) === academicYear) &&
        String(row.status).toUpperCase() !== ARAMS_CONFIG.SOFT_DELETE_STATUS;
    });
    const improvementCases = getAllObjects_(getSheet_(ss, 'GRADE_IMPROVEMENT_CASES')).filter(function (row) {
      return String(row.caseStatus || '').toUpperCase() !== 'COMPLETED' &&
        String(row.status).toUpperCase() !== ARAMS_CONFIG.SOFT_DELETE_STATUS;
    });
    const pendingGrades = grades.filter(function (row) { return !row.approvedAt && String(row.isLocked).toUpperCase() !== 'TRUE'; }).length;
    const gradeWarnings = grades.filter(function (row) { return ['0', 'ร', 'มส', 'มผ'].indexOf(String(row.resultCode || row.gradeLabel)) >= 0; });
    const attendanceCounts = { PRESENT: 0, ABSENT: 0, LATE: 0, LEAVE: 0 };
    attendance.forEach(function (row) {
      const key = String(row.attendanceStatus || '').toUpperCase();
      if (attendanceCounts[key] !== undefined) attendanceCounts[key]++;
    });
    const byLevel = {};
    students.forEach(function (row) {
      const level = String(row.currentLevel || 'ไม่ระบุ');
      byLevel[level] = (byLevel[level] || 0) + 1;
    });
    const result = {
      academicYear: academicYear,
      termCode: termCode,
      counts: {
        students: students.length,
        teachers: teachers.length,
        admissions: admissions.length,
        pendingGrades: pendingGrades,
        gradeWarnings: gradeWarnings.length,
        openGradeImprovements: improvementCases.length,
        classrooms: getAllObjects_(getSheet_(ss, 'CLASSROOMS')).filter(function (r) { return String(r.status).toUpperCase() !== ARAMS_CONFIG.SOFT_DELETE_STATUS; }).length
      },
      studentsByLevel: byLevel,
      attendance: attendanceCounts,
      gradeWarningBreakdown: countByField_(gradeWarnings, 'resultCode'),
      recentRequests: getAllObjects_(getSheet_(ss, 'SERVICE_REQUESTS')).filter(function (r) {
        return !['COMPLETED', 'REJECTED', 'CANCELLED'].includes(String(r.requestStatus || '').toUpperCase()) &&
          String(r.status).toUpperCase() !== ARAMS_CONFIG.SOFT_DELETE_STATUS;
      }).slice(-10).reverse(),
      generatedAt: nowIso_()
    };
    try { CacheService.getScriptCache().put(dashboardCacheKey, JSON.stringify(result), 20); } catch (ignore) {}
    return apiSuccess_('ดึงภาพรวมเรียบร้อยแล้ว', result);
  } catch (error) { return mapApiError_(error); }
}

function apiGetModules_(token) {
  try {
    const user = getSessionUser_(token);
    if (!user) return apiError_('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    const visible = Object.keys(ARAMS_MODULES).map(function (key) {
      const module = ARAMS_MODULES[key];
      return {
        code: module.code,
        label: module.label,
        tables: module.tables,
        defaultTable: module.defaultTable,
        canRead: hasPermission_(user, module.code, 'read'),
        canCreate: hasPermission_(user, module.code, 'create'),
        canUpdate: hasPermission_(user, module.code, 'update'),
        canDelete: hasPermission_(user, module.code, 'delete')
      };
    }).filter(function (module) { return module.canRead || module.code === 'dashboard'; });
    return apiSuccess_('ดึงเมนูเรียบร้อยแล้ว', visible);
  } catch (error) { return mapApiError_(error); }
}

function apiSystemStatus_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const spreadsheetId = props.getProperty(SCRIPT_PROPERTY_KEYS.SPREADSHEET_ID);
    return apiSuccess_('ตรวจสอบสถานะเรียบร้อยแล้ว', {
      app: ARAMS_CONFIG.APP_NAME,
      version: ARAMS_CONFIG.APP_VERSION,
      initialized: Boolean(spreadsheetId),
      imageUploadConfigured: Boolean(props.getProperty(SCRIPT_PROPERTY_KEYS.IMGBB_API_KEY)),
      timestamp: nowIso_()
    });
  } catch (error) { return apiError_('ไม่สามารถตรวจสอบสถานะระบบได้'); }
}

function apiGetOptions_(token, data) {
  try {
    const user = requirePermission_(token, String(data.module || 'settings'), 'read');
    const optionType = String(data.type || '').trim();
    const ss = getDatabaseSpreadsheet_();
    let result = [];
    if (optionType === 'academicYears') {
      result = getAllObjects_(getSheet_(ss, 'ACADEMIC_YEARS')).filter(isActiveRecord_);
    } else if (optionType === 'terms') {
      result = getAllObjects_(getSheet_(ss, 'ACADEMIC_TERMS')).filter(function (r) {
        return isActiveRecord_(r) && (!data.academicYear || String(r.academicYear) === String(data.academicYear));
      });
    } else if (optionType === 'classrooms') {
      result = getAllObjects_(getSheet_(ss, 'CLASSROOMS')).filter(function (r) {
        return isActiveRecord_(r) && (!data.academicYear || String(r.academicYear) === String(data.academicYear));
      });
    } else if (optionType === 'subjects') {
      result = getAllObjects_(getSheet_(ss, 'SUBJECTS')).filter(isActiveRecord_);
    } else if (optionType === 'teachers') {
      result = getAllObjects_(getSheet_(ss, 'TEACHERS')).filter(isActiveRecord_);
    } else if (optionType === 'gradeScale') {
      result = getAllObjects_(getSheet_(ss, 'GRADE_SCALE')).filter(isActiveRecord_);
    } else if (optionType === 'roles') {
      result = getAllObjects_(getSheet_(ss, 'ROLES')).filter(isActiveRecord_);
    } else if (optionType === 'modules') {
      result = Object.keys(ARAMS_MODULES).map(function (key) {
        return { value: key, label: ARAMS_MODULES[key].label };
      });
    } else {
      return apiError_('ไม่พบชุดข้อมูลตัวเลือกที่ต้องการ');
    }
    result = result.map(function (row) { return sanitizeRecordForClient_(row, '', user); });
    return apiSuccess_('ดึงตัวเลือกเรียบร้อยแล้ว', result);
  } catch (error) { return mapApiError_(error); }
}

function apiAuditList_(token, data) {
  try {
    const user = requirePermission_(token, 'settings', 'read');
    const requestedPage = parseInt(data.page, 10);
    const requestedPageSize = parseInt(data.pageSize, 10);
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const pageSize = Number.isFinite(requestedPageSize) && requestedPageSize > 0 ? Math.min(100, requestedPageSize) : 50;
    const records = getAllObjects_(getSheet_(getDatabaseSpreadsheet_(), 'AUDIT_LOGS'))
      .filter(function (row) { return matchesFilters_(row, data.filters || {}); })
      .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
    const start = (page - 1) * pageSize;
    return apiSuccess_('ดึงประวัติการใช้งานเรียบร้อยแล้ว', {
      records: records.slice(start, start + pageSize),
      pagination: { page: page, pageSize: pageSize, total: records.length, totalPages: Math.max(1, Math.ceil(records.length / pageSize)) }
    });
  } catch (error) { return mapApiError_(error); }
}

function apiStudentSummary_(token, data) {
  try {
    const user = getSessionUser_(token);
    if (!user) return apiError_('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    if (!hasPermission_(user, 'students', 'read')) return apiError_('คุณไม่มีสิทธิ์เข้าถึงข้อมูลนักเรียน');
    const requestedStudentId = String(data.studentId || user.studentId || '').trim();
    if (!requestedStudentId) return apiError_('ไม่พบข้อมูลนักเรียนที่ต้องการ');
    const ss = getDatabaseSpreadsheet_();
    const student = findRecordById_(getSheet_(ss, 'STUDENTS'), requestedStudentId) ||
      findRecordByField_(getSheet_(ss, 'STUDENTS'), 'studentCode', requestedStudentId);
    if (!student) return apiError_('ไม่พบข้อมูลนักเรียนที่ต้องการ');
    const visibilityContext = buildVisibilityContext_(user);
    if (!isRecordVisibleToUser_(student, 'STUDENTS', user, visibilityContext)) return apiError_('ไม่มีสิทธิ์เข้าถึงข้อมูลนักเรียนนี้');
    const related = function (table, field) {
      return getAllObjects_(getSheet_(ss, table)).filter(function (row) {
        return String(row[field || 'studentId']) === String(student.id) &&
          String(row.status).toUpperCase() !== ARAMS_CONFIG.SOFT_DELETE_STATUS &&
          isRecordVisibleToUser_(row, table, user, visibilityContext);
      }).map(function (row) { return sanitizeRecordForClient_(row, table, user); });
    };
    return apiSuccess_('ดึงข้อมูลนักเรียนเรียบร้อยแล้ว', {
      student: sanitizeRecordForClient_(student, 'STUDENTS', user),
      registrations: related('REGISTRATIONS'),
      grades: related('GRADE_RESULTS'),
      attendance: related('ATTENDANCE_SUMMARIES'),
      gradeImprovements: related('GRADE_IMPROVEMENT_CASES'),
      portfolio: related('STUDENT_PORTFOLIOS'),
      alerts: related('STUDENT_ALERTS'),
      documents: related('STUDENT_DOCUMENTS')
    });
  } catch (error) { return mapApiError_(error); }
}

function apiValidateRegistration_(token, data) {
  try {
    requirePermission_(token, 'registration', 'create');
    const studentId = String(data.studentId || '');
    const subjectId = String(data.subjectId || '');
    const academicYear = String(data.academicYear || '');
    const termCode = String(data.termCode || '');
    if (!studentId || !subjectId || !academicYear || !termCode) return apiError_('กรุณาระบุข้อมูลการลงทะเบียนให้ครบถ้วน');
    const registrations = getAllObjects_(getSheet_(getDatabaseSpreadsheet_(), 'REGISTRATIONS'));
    const duplicate = registrations.some(function (row) {
      return String(row.studentId) === studentId && String(row.subjectId) === subjectId &&
        String(row.academicYear) === academicYear && String(row.termCode) === termCode &&
        !['WITHDRAWN', 'CANCELLED', 'DELETED'].includes(String(row.registrationStatus || row.status).toUpperCase());
    });
    const subject = findRecordById_(getSheet_(getDatabaseSpreadsheet_(), 'SUBJECTS'), subjectId);
    if (!subject) return apiError_('ไม่พบข้อมูลรายวิชาที่ต้องการลงทะเบียน');
    const prerequisiteIds = parseJsonArray_(subject.prerequisiteSubjectIds);
    const gradeRows = getAllObjects_(getSheet_(getDatabaseSpreadsheet_(), 'GRADE_RESULTS'));
    const passedSubjects = gradeRows.filter(function (row) {
      if (String(row.studentId) !== studentId || String(row.status).toUpperCase() === ARAMS_CONFIG.SOFT_DELETE_STATUS) return false;
      const resultCode = String(row.resultCode || '').trim().toUpperCase();
      const gradeLabel = String(row.gradeLabel || '').trim().toUpperCase();
      const gradePoint = Number(row.gradePoint);
      return ['PASS', 'ผ่าน', 'ผ'].indexOf(resultCode) >= 0 ||
        ['PASS', 'ผ่าน', 'ผ'].indexOf(gradeLabel) >= 0 ||
        (!isNaN(gradePoint) && gradePoint > 0);
    }).map(function (row) { return String(row.subjectId); });
    const missingPrerequisites = prerequisiteIds.filter(function (id) { return passedSubjects.indexOf(String(id)) < 0; });
    return apiSuccess_('ตรวจสอบเงื่อนไขเรียบร้อยแล้ว', {
      valid: !duplicate && missingPrerequisites.length === 0,
      duplicate: duplicate,
      missingPrerequisites: missingPrerequisites,
      subject: { subjectCode: subject.subjectCode, subjectName: subject.subjectName, credit: subject.credit }
    });
  } catch (error) { return mapApiError_(error); }
}

function apiCalculateGrades_(token, data) {
  try {
    const user = requirePermission_(token, 'assessment', 'read');
    const visibilityContext = buildVisibilityContext_(user);
    const subjectId = String(data.subjectId || '');
    const academicYear = String(data.academicYear || '');
    const termCode = String(data.termCode || '');
    if (!subjectId || !academicYear || !termCode) return apiError_('กรุณาระบุรายวิชา ปีการศึกษา และภาคเรียน');
    const ss = getDatabaseSpreadsheet_();
    const scores = getAllObjects_(getSheet_(ss, 'SCORES')).filter(function (row) {
      return String(row.subjectId) === subjectId && String(row.academicYear) === academicYear &&
        String(row.termCode) === termCode && String(row.status).toUpperCase() !== ARAMS_CONFIG.SOFT_DELETE_STATUS &&
        isRecordVisibleToUser_(row, 'SCORES', user, visibilityContext);
    });
    const assessmentItems = getAllObjects_(getSheet_(ss, 'ASSESSMENT_ITEMS'));
    const itemMap = {};
    assessmentItems.forEach(function (item) { itemMap[String(item.id)] = item; });
    const gradeScale = getAllObjects_(getSheet_(ss, 'GRADE_SCALE')).filter(isActiveRecord_);
    const subject = findRecordById_(getSheet_(ss, 'SUBJECTS'), subjectId);
    const byStudent = {};
    scores.forEach(function (row) {
      const id = String(row.studentId || '');
      if (!id) return;
      if (!byStudent[id]) byStudent[id] = { studentId: id, weightedScore: 0, totalWeight: 0, rawScore: 0, rawMax: 0, items: 0 };
      const item = itemMap[String(row.assessmentItemId)] || {};
      const maxScore = Number(row.maxScore || item.maxScore || 0);
      const score = Number(row.score || 0);
      const weight = Number(item.weight || maxScore || 0);
      if (maxScore > 0) byStudent[id].weightedScore += (score / maxScore) * weight;
      byStudent[id].totalWeight += weight;
      byStudent[id].rawScore += score;
      byStudent[id].rawMax += maxScore;
      byStudent[id].items++;
    });
    const results = Object.keys(byStudent).map(function (studentId) {
      const summary = byStudent[studentId];
      const percentage = summary.totalWeight > 0 ? summary.weightedScore / summary.totalWeight * 100 : 0;
      const scale = gradeScale.find(function (row) {
        return percentage >= Number(row.minScore || 0) && percentage <= Number(row.maxScore || 100);
      });
      return {
        studentId: studentId,
        totalScore: roundNumber_(summary.weightedScore, 2),
        maxScore: roundNumber_(summary.totalWeight, 2),
        rawScore: roundNumber_(summary.rawScore, 2),
        rawMaxScore: roundNumber_(summary.rawMax, 2),
        percentage: roundNumber_(percentage, 2),
        gradeLabel: scale ? scale.gradeLabel : '',
        gradePoint: scale ? Number(scale.gradePoint || 0) : 0,
        resultCode: scale ? (String(scale.passStatus).toUpperCase() === 'PASS' ? 'ผ่าน' : '0') : 'รอตรวจสอบ',
        itemCount: summary.items,
        credit: subject ? Number(subject.credit || 0) : 0
      };
    });
    return apiSuccess_('คำนวณคะแนนเรียบร้อยแล้ว', {
      subject: subject ? { id: subject.id, subjectCode: subject.subjectCode, subjectName: subject.subjectName } : null,
      academicYear: academicYear, termCode: termCode, results: results
    });
  } catch (error) { return mapApiError_(error); }
}

function apiApproveGrades_(token, data) {
  try {
    const user = requirePermission_(token, 'assessment', 'approve');
    const visibilityContext = buildVisibilityContext_(user);
    const ids = Array.isArray(data.gradeResultIds) ? data.gradeResultIds : [];
    if (!ids.length) return apiError_('กรุณาเลือกรายการผลการเรียนที่ต้องการอนุมัติ');
    if (ids.length > 500) return apiError_('อนุมัติได้ไม่เกิน 500 รายการต่อครั้ง');
    const sheet = getSheet_(getDatabaseSpreadsheet_(), 'GRADE_RESULTS');
    const lock = LockService.getScriptLock();
    lock.waitLock(ARAMS_CONFIG.LOCK_WAIT_MS);
    let approved = 0; let skipped = 0;
    try {
      ids.forEach(function (id) {
        const record = findRecordById_(sheet, String(id));
        if (!record || String(record.isLocked).toUpperCase() === 'TRUE' ||
            !isRecordVisibleToUser_(record, 'GRADE_RESULTS', user, visibilityContext)) { skipped++; return; }
        updateRecordById_(sheet, record.id, {
          approvedAt: nowIso_(), approvedBy: user.userId,
          isLocked: 'TRUE', updatedAt: nowIso_(), updatedBy: user.userId
        });
        appendObject_(getSheet_(getDatabaseSpreadsheet_(), 'GRADE_APPROVALS'), Object.assign(baseRecord_(user.userId), {
          gradeResultId: record.id, studentId: record.studentId, subjectId: record.subjectId,
          academicYear: record.academicYear, termCode: record.termCode,
          workflowStep: 'FINAL_APPROVAL', approverUserId: user.userId,
          decision: 'APPROVED', decisionDate: nowIso_(), reason: String(data.reason || '')
        }));
        approved++;
      });
      invalidateDashboardCache_();
      appendAuditLog_(user, { action: 'APPROVE_GRADES', module: 'assessment', tableName: 'GRADE_RESULTS', reason: 'approved=' + approved + ';skipped=' + skipped });
    } finally { lock.releaseLock(); }
    return apiSuccess_('ดำเนินการอนุมัติผลการเรียนเรียบร้อยแล้ว', { approved: approved, skipped: skipped });
  } catch (error) { return mapApiError_(error); }
}

function apiCheckGraduation_(token, data) {
  try {
    const user = requirePermission_(token, 'graduation', 'read');
    const studentId = String(data.studentId || user.studentId || '');
    const level = String(data.level || 'ม.6');
    const curriculumId = String(data.curriculumId || '');
    if (!studentId) return apiError_('กรุณาระบุนักเรียนที่ต้องการตรวจสอบ');
    const visibilityContext = buildVisibilityContext_(user);
    const student = findRecordById_(getSheet_(getDatabaseSpreadsheet_(), 'STUDENTS'), studentId);
    if (!student || !isRecordVisibleToUser_(student, 'STUDENTS', user, visibilityContext)) return apiError_('ไม่มีสิทธิ์ตรวจสอบข้อมูลนักเรียนนี้');
    if (user.roleCodes.indexOf('PARENT') >= 0 &&
        !(visibilityContext.childAccess[String(student.id)] && visibilityContext.childAccess[String(student.id)].canViewGrades)) {
      return apiError_('ไม่มีสิทธิ์ตรวจสอบผลการเรียนของนักเรียนรายนี้');
    }
    const ss = getDatabaseSpreadsheet_();
    const requirements = getAllObjects_(getSheet_(ss, 'GRADUATION_REQUIREMENTS')).filter(function (row) {
      return String(row.level) === level && (!curriculumId || String(row.curriculumId) === curriculumId) && isActiveRecord_(row);
    });
    const credits = getAllObjects_(getSheet_(ss, 'STUDENT_CREDITS')).filter(function (row) {
      return String(row.studentId) === studentId && String(row.status).toUpperCase() !== ARAMS_CONFIG.SOFT_DELETE_STATUS;
    });
    const grades = getAllObjects_(getSheet_(ss, 'GRADE_RESULTS')).filter(function (row) { return String(row.studentId) === studentId; });
    const earnedCredits = credits.reduce(function (sum, row) { return sum + Number(row.creditEarned || 0); }, 0);
    const totalCredits = credits.reduce(function (sum, row) { return sum + Number(row.credit || 0); }, 0);
    const gpaRows = grades.filter(function (row) { return row.gradePoint !== '' && row.credit !== ''; });
    const gpaCredits = gpaRows.reduce(function (sum, row) { return sum + Number(row.credit || 0); }, 0);
    const gpa = gpaCredits > 0 ? gpaRows.reduce(function (sum, row) { return sum + Number(row.gradePoint || 0) * Number(row.credit || 0); }, 0) / gpaCredits : 0;
    const outstanding = [];
    requirements.forEach(function (req) {
      if (req.requirementCode === 'MIN_CREDITS' && earnedCredits < Number(req.minimumCredits || 0)) {
        outstanding.push({ code: req.requirementCode, name: req.requirementName, required: Number(req.minimumCredits), current: earnedCredits });
      }
      if (req.requirementCode === 'MIN_GPA' && gpa < Number(req.minimumGpa || 0)) {
        outstanding.push({ code: req.requirementCode, name: req.requirementName, required: Number(req.minimumGpa), current: roundNumber_(gpa, 2) });
      }
    });
    const pendingResults = grades.filter(function (row) {
      return ['0', 'ร', 'มส', 'มผ'].indexOf(String(row.resultCode || row.gradeLabel)) >= 0 || !row.approvedAt;
    });
    if (pendingResults.length) outstanding.push({ code: 'PENDING_RESULTS', name: 'ผลการเรียนค้างหรือยังไม่อนุมัติ', count: pendingResults.length });
    const result = {
      studentId: studentId, studentCode: student.studentCode, studentName: (student.firstName || '') + ' ' + (student.lastName || ''),
      level: level, totalCredits: roundNumber_(totalCredits, 2), earnedCredits: roundNumber_(earnedCredits, 2),
      gpa: roundNumber_(gpa, 2), outstandingItems: outstanding,
      eligible: outstanding.length === 0, checkedAt: nowIso_()
    };
    return apiSuccess_('ตรวจสอบเงื่อนไขสำเร็จการศึกษาเรียบร้อยแล้ว', result);
  } catch (error) { return mapApiError_(error); }
}

function apiConvertAdmission_(token, data) {
  try {
    const user = requirePermission_(token, 'admissions', 'update');
    const admissionId = String(data.admissionId || '');
    if (!admissionId) return apiError_('ไม่พบรหัสผู้สมัคร');
    const ss = getDatabaseSpreadsheet_();
    const admissionSheet = getSheet_(ss, 'ADMISSIONS');
    const admission = findRecordById_(admissionSheet, admissionId);
    if (!admission) return apiError_('ไม่พบข้อมูลผู้สมัคร');
    if (admission.studentId) return apiError_('ผู้สมัครรายนี้ถูกสร้างเป็นนักเรียนแล้ว');
    if (!['PASS', 'SELECTED', 'ผ่าน', 'มีสิทธิ์รายงานตัว'].includes(String(admission.selectionStatus || '').toUpperCase()) && !data.forceConvert) {
      return apiError_('สถานะผู้สมัครยังไม่พร้อมสำหรับการขึ้นทะเบียนนักเรียน');
    }
    const student = Object.assign(baseRecord_(user.userId), {
      studentCode: String(data.studentCode || ''),
      nationalId: admission.nationalId || '', title: admission.title || '',
      firstName: admission.firstName || '', lastName: admission.lastName || '',
      gender: admission.gender || '', birthDate: admission.birthDate || '',
      phone: admission.phone || '', email: admission.email || '', address: admission.address || '',
      photoUrl: admission.photoUrl || '', admissionYear: admission.academicYear || '',
      admissionLevel: admission.admissionLevel || '', currentLevel: admission.admissionLevel || '',
      previousSchool: admission.previousSchool || '', enrollmentDate: nowIso_().slice(0, 10),
      studentStatus: 'ACTIVE'
    });
    const lock = LockService.getScriptLock();
    lock.waitLock(ARAMS_CONFIG.LOCK_WAIT_MS);
    try {
      if (!student.studentCode) student.studentCode = createStudentCode_(admission.academicYear, admission.admissionLevel);
      appendObject_(getSheet_(ss, 'STUDENTS'), student);
      updateRecordById_(admissionSheet, admissionId, {
        studentId: student.id, reportingStatus: 'COMPLETED', updatedAt: nowIso_(), updatedBy: user.userId
      });
      appendObject_(getSheet_(ss, 'STUDENT_STATUS_HISTORY'), Object.assign(baseRecord_(user.userId), {
        studentId: student.id, oldStatus: '', newStatus: 'ACTIVE', effectiveDate: nowIso_().slice(0, 10),
        reason: 'แปลงข้อมูลจากผู้สมัคร', approvedBy: user.userId
      }));
      invalidateDashboardCache_();
      appendAuditLog_(user, { action: 'CONVERT_ADMISSION', module: 'admissions', tableName: 'ADMISSIONS', recordId: admissionId, after: { studentId: student.id } });
    } finally { lock.releaseLock(); }
    return apiSuccess_('ขึ้นทะเบียนนักเรียนเรียบร้อยแล้ว', { student: student });
  } catch (error) { return mapApiError_(error); }
}

function apiAttendanceSummary_(token, data) {
  try {
    const user = requirePermission_(token, 'attendance', 'read');
    const filters = data.filters || {};
    const visibilityContext = buildVisibilityContext_(user);
    const rows = getAllObjects_(getSheet_(getDatabaseSpreadsheet_(), 'ATTENDANCE')).filter(function (row) {
      return matchesFilters_(row, filters) && String(row.status).toUpperCase() !== ARAMS_CONFIG.SOFT_DELETE_STATUS &&
        isRecordVisibleToUser_(row, 'ATTENDANCE', user, visibilityContext);
    });
    const map = {};
    rows.forEach(function (row) {
      const id = String(row.studentId || '');
      if (!map[id]) map[id] = { studentId: id, present: 0, absent: 0, late: 0, leave: 0, total: 0 };
      map[id].total++;
      const status = String(row.attendanceStatus || '').toUpperCase();
      if (status === 'PRESENT' || status === 'มา') map[id].present++;
      else if (status === 'ABSENT' || status === 'ขาด') map[id].absent++;
      else if (status === 'LATE' || status === 'สาย') map[id].late++;
      else if (status === 'LEAVE' || status === 'ลา') map[id].leave++;
    });
    const result = Object.keys(map).map(function (id) {
      const row = map[id];
      row.attendancePercent = row.total ? roundNumber_(row.present / row.total * 100, 2) : 0;
      return row;
    });
    return apiSuccess_('สรุปเวลาเรียนเรียบร้อยแล้ว', result);
  } catch (error) { return mapApiError_(error); }
}

function apiNextDocumentNumber_(token, data) {
  try {
    const user = requirePermission_(token, 'graduation', 'create');
    const type = String(data.documentType || '').trim();
    const year = String(data.academicYear || getSettingValue_('CURRENT_ACADEMIC_YEAR') || '').trim();
    if (!type || !year) return apiError_('กรุณาระบุประเภทเอกสารและปีการศึกษา');
    const sheet = getSheet_(getDatabaseSpreadsheet_(), 'DOCUMENT_COUNTERS');
    const lock = LockService.getScriptLock();
    lock.waitLock(ARAMS_CONFIG.LOCK_WAIT_MS);
    let number;
    try {
      let counter = getAllObjects_(sheet).find(function (row) {
        return String(row.documentType) === type && String(row.academicYear) === year;
      });
      if (!counter) {
        counter = Object.assign(baseRecord_(user.userId), {
          documentType: type, academicYear: year, prefix: String(data.prefix || type),
          lastNumber: 0, numberFormat: '{PREFIX}/{YEAR}/{NUMBER:5}'
        });
        appendObject_(sheet, counter);
      }
      const next = Number(counter.lastNumber || 0) + 1;
      updateRecordById_(sheet, counter.id, { lastNumber: next, updatedAt: nowIso_(), updatedBy: user.userId });
      const prefix = String(counter.prefix || type);
      number = prefix + '/' + year + '/' + String(next).padStart(5, '0');
      appendAuditLog_(user, { action: 'NEXT_DOCUMENT_NUMBER', module: 'graduation', tableName: 'DOCUMENT_COUNTERS', recordId: counter.id, after: { documentNo: number } });
    } finally { lock.releaseLock(); }
    return apiSuccess_('ออกเลขที่เอกสารเรียบร้อยแล้ว', { documentNo: number });
  } catch (error) { return mapApiError_(error); }
}

function apiExportCsv_(token, data) {
  try {
    const moduleInfo = resolveModuleAndTable_(data);
    const user = requirePermission_(token, moduleInfo.moduleCode, 'read');
    const exportSheet = getSheet_(getDatabaseSpreadsheet_(), moduleInfo.tableName);
    const exportHeaders = getHeaders_(exportSheet);
    const visibilityContext = buildVisibilityContext_(user);
    const rows = getAllObjects_(exportSheet).filter(function (row) {
      return String(row.status).toUpperCase() !== ARAMS_CONFIG.SOFT_DELETE_STATUS &&
        matchesFilters_(row, data.filters || {}) &&
        isRecordVisibleToUser_(row, moduleInfo.tableName, user, visibilityContext);
    }).slice(0, 5000);
    const fields = Array.isArray(data.fields) && data.fields.length ? data.fields : exportHeaders;
    const forbiddenExportFields = ['passwordHash', 'passwordSalt', 'deleteUrl'].concat(
      getRestrictedFieldsForUser_(moduleInfo.tableName, user)
    );
    const safeFields = fields.filter(function (field) {
      return exportHeaders.indexOf(field) >= 0 && forbiddenExportFields.indexOf(field) < 0;
    });
    const lines = [safeFields.map(csvEscape_).join(',')];
    rows.forEach(function (row) { lines.push(safeFields.map(function (field) { return csvEscape_(row[field]); }).join(',')); });
    const csv = '\uFEFF' + lines.join('\r\n');
    appendAuditLog_(user, { action: 'EXPORT_CSV', module: moduleInfo.moduleCode, tableName: moduleInfo.tableName, reason: 'rows=' + rows.length });
    return apiSuccess_('เตรียมไฟล์ข้อมูลเรียบร้อยแล้ว', {
      fileName: moduleInfo.tableName + '_' + Utilities.formatDate(new Date(), ARAMS_CONFIG.TIME_ZONE, 'yyyyMMdd_HHmmss') + '.csv',
      mimeType: 'text/csv;charset=utf-8',
      csv: csv,
      rowCount: rows.length
    });
  } catch (error) { return mapApiError_(error); }
}

/* ========================================================================== *
 *  SECTION 10 - MODULE/TABLE RESOLUTION AND DATA VALIDATION
 * ========================================================================== */

function resolveModuleAndTable_(data) {
  const requestedModule = String(data.module || '').trim();
  let moduleInfo = ARAMS_MODULES[requestedModule];
  if (!moduleInfo) {
    const alias = Object.keys(ARAMS_MODULES).find(function (key) { return ARAMS_MODULES[key].code === requestedModule; });
    if (alias) moduleInfo = ARAMS_MODULES[alias];
  }
  if (!moduleInfo) throw new Error('MODULE_NOT_FOUND');
  const tableName = String(data.table || moduleInfo.defaultTable || '').trim().toUpperCase();
  if (!tableName || !ARAMS_SCHEMA[tableName]) throw new Error('TABLE_NOT_ALLOWED');
  if (moduleInfo.tables.indexOf(tableName) < 0) throw new Error('TABLE_NOT_ALLOWED');
  const actualModule = TABLE_TO_MODULE[tableName] || moduleInfo.code;
  return { moduleCode: moduleInfo.code, tableName: tableName, tableModuleCode: actualModule };
}

function validateRecord_(tableName, record, mode) {
  const headers = ARAMS_SCHEMA[tableName];
  if (!headers) throw new Error('TABLE_NOT_ALLOWED');
  const allowed = {};
  headers.forEach(function (header) { allowed[header] = true; });
  Object.keys(record).forEach(function (key) {
    if (!allowed[key] && !['deletedAt', 'deletedBy', 'deletionReason'].includes(key)) {
      throw new Error('INVALID_FIELD:' + key);
    }
  });
  if (mode === 'create' && ['USERS', 'ROLES', 'PERMISSIONS', 'ROLE_PERMISSIONS', 'AUDIT_LOGS', 'AUTH_ATTEMPTS'].includes(tableName)) {
    if (tableName === 'USERS') {
      // User accounts should be provisioned by administrator workflows only.
      throw new Error('USE_USER_ADMIN_WORKFLOW');
    }
    if (['AUDIT_LOGS', 'AUTH_ATTEMPTS'].includes(tableName)) throw new Error('SYSTEM_TABLE_READ_ONLY');
  }
  if (mode === 'update' && tableName === 'USERS') {
    const safeUserFields = ['displayName', 'firstName', 'lastName', 'phone', 'notes'];
    if (Object.keys(record).some(function (field) { return safeUserFields.indexOf(field) < 0; })) {
      throw new Error('USER_SECURITY_FIELDS_PROTECTED');
    }
  }
}

function prepareRecordForWrite_(tableName, record, user) {
  const headers = getHeaders_(getSheet_(getDatabaseSpreadsheet_(), tableName));
  const output = {};
  headers.forEach(function (header) {
    if (Object.prototype.hasOwnProperty.call(record, header)) {
      output[header] = normalizeCellValue_(record[header]);
    }
  });
  if (tableName === 'USERS') {
    delete output.passwordHash;
    delete output.passwordSalt;
    delete output.roleCodes;
  }
  return output;
}

function checkUniqueConstraints_(sheet, tableName, record, mode, excludeId) {
  const constraints = {
    STUDENTS: ['studentCode', 'nationalId'],
    TEACHERS: ['teacherCode', 'nationalId', 'email'],
    GUARDIANS: ['guardianCode', 'nationalId'],
    USERS: ['email', 'username'],
    SUBJECTS: ['subjectCode'],
    ADMISSIONS: ['applicationNo'],
    CLASSROOMS: ['academicYear|className'],
    REGISTRATIONS: ['registrationNo']
  }[tableName] || [];
  const rows = getAllObjects_(sheet);
  constraints.forEach(function (constraint) {
    const fields = constraint.split('|');
    const values = fields.map(function (field) { return String(record[field] || '').trim().toLowerCase(); });
    if (values.every(function (value) { return !value; })) return;
    const duplicate = rows.some(function (row) {
      if (excludeId && String(row.id) === String(excludeId)) return false;
      if (String(row.status).toUpperCase() === ARAMS_CONFIG.SOFT_DELETE_STATUS) return false;
      return fields.every(function (field, index) {
        return String(row[field] || '').trim().toLowerCase() === values[index];
      });
    });
    if (duplicate) throw new Error('DUPLICATE_RECORD');
  });
}

/* ========================================================================== *
 *  SECTION 11 - ROW-LEVEL VISIBILITY CONTROLS
 * ========================================================================== */

function buildVisibilityContext_(user) {
  const roles = user && Array.isArray(user.roleCodes) ? user.roleCodes : [];
  const context = {
    roles: roles,
    studentId: String(user && user.studentId || ''),
    childIds: [],
    childAccess: {},
    advisorStudentIds: [],
    teacherScope: { sectionIds: [], studentIds: [] }
  };
  if (roles.indexOf('PARENT') >= 0) {
    context.childAccess = getParentStudentAccess_(user);
    context.childIds = Object.keys(context.childAccess);
  }
  if (roles.indexOf('ADVISOR') >= 0 || roles.indexOf('GUIDANCE') >= 0) {
    context.advisorStudentIds = getAdvisorStudentIds_(user);
  }
  if ((roles.indexOf('TEACHER') >= 0 || roles.indexOf('DEPARTMENT_HEAD') >= 0) && !roles.some(function (role) {
    return ['ADVISOR', 'GUIDANCE', 'ACADEMIC_VICE_DIRECTOR'].indexOf(role) >= 0;
  })) {
    context.teacherScope = getTeacherStudentScope_(user);
  }
  return context;
}

function isRecordVisibleToUser_(record, tableName, user, visibilityContext) {
  if (!user) return false;
  const context = visibilityContext || buildVisibilityContext_(user);
  const roles = context.roles || user.roleCodes || [];
  if (roles.indexOf('SUPER_ADMIN') >= 0 || roles.indexOf('ADMIN') >= 0) return true;

  if (roles.indexOf('STUDENT') >= 0) {
    const studentId = context.studentId;
    if (!studentId) return false;
    if (tableName === 'STUDENTS') return String(record.id) === studentId;
    if (tableName === 'NOTIFICATIONS') return String(record.recipientUserId || '') === String(user.userId || '');
    if (['STUDENT_ALERTS', 'COUNSELING_RECORDS', 'ADVISOR_ASSIGNMENTS'].indexOf(tableName) >= 0) return false;
    if (tableHasStudentId_(tableName)) return String(record.studentId || '') === studentId;
    return ['ACADEMIC_YEARS', 'ACADEMIC_TERMS', 'ACADEMIC_CALENDAR', 'SCHOOL_EVENTS', 'SUBJECTS', 'TIMETABLES', 'TIMETABLE_ENTRIES'].indexOf(tableName) >= 0;
  }

  if (roles.indexOf('PARENT') >= 0) {
    const childAccess = context.childAccess || {};
    const childId = String(record.studentId || '');
    if (tableName === 'STUDENTS') return Boolean(childAccess[String(record.id)]);
    if (tableName === 'PARENT_LINKS') {
      return String(record.parentUserId || '') === String(user.userId || '') &&
        String(record.isVerified).toUpperCase() === 'TRUE';
    }
    if (tableName === 'NOTIFICATIONS') return String(record.recipientUserId || '') === String(user.userId || '');
    if (['STUDENT_ALERTS', 'COUNSELING_RECORDS', 'ADVISOR_ASSIGNMENTS'].indexOf(tableName) >= 0) return false;
    if (['GRADE_RESULTS', 'SCORES', 'STUDENT_CREDITS', 'STUDENT_ACTIVITY_RESULTS',
      'CHARACTER_ASSESSMENTS', 'READING_THINKING_ASSESSMENTS', 'COMPETENCY_ASSESSMENTS',
      'GRADE_IMPROVEMENT_CASES', 'GRADE_IMPROVEMENT_ACTIVITIES', 'STUDENT_DOCUMENTS'].indexOf(tableName) >= 0) {
      return Boolean(childAccess[childId] && childAccess[childId].canViewGrades);
    }
    if (['ATTENDANCE', 'ATTENDANCE_SUMMARIES'].indexOf(tableName) >= 0) {
      return Boolean(childAccess[childId] && childAccess[childId].canViewAttendance);
    }
    if (tableName === 'SERVICE_REQUESTS') {
      return Boolean(childAccess[childId] && childAccess[childId].canSubmitRequests);
    }
    if (tableHasStudentId_(tableName)) return Boolean(childAccess[childId]);
    return ['ACADEMIC_YEARS', 'ACADEMIC_TERMS', 'ACADEMIC_CALENDAR', 'SCHOOL_EVENTS', 'SUBJECTS'].indexOf(tableName) >= 0;
  }

  if ((roles.indexOf('TEACHER') >= 0 || roles.indexOf('DEPARTMENT_HEAD') >= 0) && !roles.some(function (role) {
    return ['ADVISOR', 'GUIDANCE', 'ACADEMIC_VICE_DIRECTOR'].indexOf(role) >= 0;
  })) {
    const teacherId = String(user.teacherId || '');
    if (!teacherId) return false;
    if (tableName === 'TEACHERS') return String(record.id) === teacherId;
    if (tableName === 'TEACHER_PROFILES' || tableName === 'TEACHER_WORKLOAD') return String(record.teacherId) === teacherId;
    if (tableName === 'COURSE_SECTIONS' || tableName === 'TEACHER_ASSIGNMENTS' || tableName === 'TIMETABLE_ENTRIES') {
      return String(record.teacherId) === teacherId;
    }
    if (tableHasStudentId_(tableName)) {
      if (String(record.teacherId || '') === teacherId) return true;
      const scope = context.teacherScope || { sectionIds: [], studentIds: [] };
      if (record.courseSectionId && scope.sectionIds.indexOf(String(record.courseSectionId)) >= 0) return true;
      return scope.studentIds.indexOf(String(record.studentId || '')) >= 0;
    }
    if (tableName === 'STUDENTS') {
      return (context.teacherScope || { studentIds: [] }).studentIds.indexOf(String(record.id)) >= 0;
    }
    return ['ACADEMIC_YEARS', 'ACADEMIC_TERMS', 'ACADEMIC_CALENDAR', 'SCHOOL_EVENTS', 'SUBJECTS', 'ROOMS'].indexOf(tableName) >= 0;
  }

  if (roles.indexOf('ADVISOR') >= 0 || roles.indexOf('GUIDANCE') >= 0) {
    const ids = context.advisorStudentIds || [];
    if (tableName === 'STUDENTS') return ids.indexOf(String(record.id)) >= 0;
    if (tableHasStudentId_(tableName)) return ids.indexOf(String(record.studentId || '')) >= 0;
  }

  return true;
}

function invalidateDashboardCache_() {
  const version = createRandomToken_();
  PropertiesService.getScriptProperties().setProperty('ARAMS_DASHBOARD_CACHE_VERSION', version);
}

function getVisibilityCacheVersion_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('ARAMS_VISIBILITY_CACHE_VERSION');
  if (cached) return cached;
  const version = PropertiesService.getScriptProperties().getProperty('ARAMS_VISIBILITY_CACHE_VERSION') || '1';
  cache.put('ARAMS_VISIBILITY_CACHE_VERSION', version, 60);
  return version;
}

function invalidateVisibilityScopeCache_() {
  const next = createRandomToken_();
  PropertiesService.getScriptProperties().setProperty('ARAMS_VISIBILITY_CACHE_VERSION', next);
  CacheService.getScriptCache().put('ARAMS_VISIBILITY_CACHE_VERSION', next, 60);
}

function getCachedScope_(scopeType, userId, builder) {
  const cache = CacheService.getScriptCache();
  const key = 'ARAMS_SCOPE_' + scopeType + '_' + getVisibilityCacheVersion_() + '_' + sha256Hex_(String(userId || '')).slice(0, 24);
  const cached = cache.get(key);
  if (cached) {
    try { return JSON.parse(cached); } catch (ignore) {}
  }
  const result = builder();
  try { cache.put(key, JSON.stringify(result), 60); } catch (ignore) {}
  return result;
}

function isVisibilitySourceTable_(tableName) {
  return ['PARENT_LINKS', 'ADVISOR_ASSIGNMENTS', 'TEACHER_ASSIGNMENTS', 'COURSE_SECTIONS',
    'REGISTRATIONS', 'CLASS_MEMBERSHIPS'].indexOf(String(tableName)) >= 0;
}

function getTeacherStudentScope_(user) {
  return getCachedScope_('TEACHER', user.userId || user.teacherId, function () {
    const ss = getDatabaseSpreadsheet_();
    const teacherId = String(user.teacherId || '');
    const assignments = getAllObjects_(getSheet_(ss, 'TEACHER_ASSIGNMENTS')).filter(function (row) {
      return String(row.teacherId) === teacherId && isActiveRecord_(row);
    });
    const sections = getAllObjects_(getSheet_(ss, 'COURSE_SECTIONS')).filter(function (row) {
      return String(row.teacherId) === teacherId && isActiveRecord_(row);
    });
    const sectionIds = assignments.map(function (row) { return String(row.courseSectionId || ''); })
      .concat(sections.map(function (row) { return String(row.id); })).filter(Boolean);
    const classroomIds = assignments.map(function (row) { return String(row.classroomId || ''); })
      .concat(sections.map(function (row) { return String(row.classroomId || ''); })).filter(Boolean);
    const sectionSet = {};
    const classroomSet = {};
    sectionIds.forEach(function (id) { sectionSet[id] = true; });
    classroomIds.forEach(function (id) { classroomSet[id] = true; });
    const studentIds = {};
    getAllObjects_(getSheet_(ss, 'REGISTRATIONS')).forEach(function (row) {
      if (sectionSet[String(row.courseSectionId || '')] && row.studentId) studentIds[String(row.studentId)] = true;
    });
    getAllObjects_(getSheet_(ss, 'CLASS_MEMBERSHIPS')).forEach(function (row) {
      if (classroomSet[String(row.classroomId || '')] && row.studentId) studentIds[String(row.studentId)] = true;
    });
    return { sectionIds: Object.keys(sectionSet), studentIds: Object.keys(studentIds) };
  });
}

function getParentStudentAccess_(user) {
  return getCachedScope_('PARENT_ACCESS', user.userId, function () {
    const rows = getAllObjects_(getSheet_(getDatabaseSpreadsheet_(), 'PARENT_LINKS'));
    const access = {};
    rows.forEach(function (row) {
      if (String(row.parentUserId) !== String(user.userId) ||
          String(row.isVerified).toUpperCase() !== 'TRUE' || !isActiveRecord_(row)) return;
      access[String(row.studentId)] = {
        canViewGrades: String(row.canViewGrades).toUpperCase() === 'TRUE',
        canViewAttendance: String(row.canViewAttendance).toUpperCase() === 'TRUE',
        canSubmitRequests: String(row.canSubmitRequests).toUpperCase() === 'TRUE'
      };
    });
    return access;
  });
}

function getLinkedStudentIds_(user) {
  return Object.keys(getParentStudentAccess_(user));
}

function getAdvisorStudentIds_(user) {
  return getCachedScope_('ADVISOR', user.userId || user.teacherId, function () {
    const ss = getDatabaseSpreadsheet_();
    const assignments = getAllObjects_(getSheet_(ss, 'ADVISOR_ASSIGNMENTS'));
    const memberships = getAllObjects_(getSheet_(ss, 'CLASS_MEMBERSHIPS'));
    const idSet = {};
    assignments.forEach(function (row) {
      if (String(row.teacherId) !== String(user.teacherId) || !isActiveRecord_(row)) return;
      parseJsonArray_(row.studentIdsJson).forEach(function (id) { idSet[String(id)] = true; });
      const roomId = String(row.classroomId || '');
      if (roomId) {
        memberships.forEach(function (membership) {
          if (String(membership.classroomId) === roomId &&
              String(membership.academicYear) === String(row.academicYear) &&
              isActiveRecord_(membership)) idSet[String(membership.studentId)] = true;
        });
      }
    });
    return Object.keys(idSet);
  });
}

function canCreateRecordForUser_(record, tableName, user) {
  const roles = user.roleCodes || [];
  if (roles.indexOf('SUPER_ADMIN') >= 0 || roles.indexOf('ADMIN') >= 0) return true;

  if (roles.indexOf('STUDENT') >= 0) {
    return ['SERVICE_REQUESTS', 'STUDENT_PORTFOLIOS', 'PORTFOLIO_ITEMS'].indexOf(tableName) >= 0 &&
      String(record.studentId || '') === String(user.studentId || '');
  }
  if (roles.indexOf('PARENT') >= 0) {
    const parentAccess = getParentStudentAccess_(user);
    const childAccess = parentAccess[String(record.studentId || '')];
    return tableName === 'SERVICE_REQUESTS' && Boolean(childAccess && childAccess.canSubmitRequests);
  }

  if (roles.indexOf('TEACHER') >= 0 || roles.indexOf('ADVISOR') >= 0 || roles.indexOf('GUIDANCE') >= 0) {
    if (tableName === 'TEACHERS' || tableName === 'TEACHER_PROFILES' || tableName === 'TEACHER_WORKLOAD') {
      return String(record.teacherId || '') === String(user.teacherId || '');
    }
    if (tableHasStudentId_(tableName)) {
      if (record.teacherId && String(record.teacherId) !== String(user.teacherId || '')) return false;
      return isRecordVisibleToUser_(record, tableName, user);
    }
    return false;
  }
  return true;
}

function canUpdateRecordForUser_(before, patch, tableName, user) {
  if (user.roleCodes.indexOf('SUPER_ADMIN') >= 0 || user.roleCodes.indexOf('ADMIN') >= 0) return true;
  if (!isRecordVisibleToUser_(before, tableName, user)) return false;
  if (tableName === 'GRADE_RESULTS' && String(before.isLocked).toUpperCase() === 'TRUE') return false;
  if (user.roleCodes.indexOf('STUDENT') >= 0 || user.roleCodes.indexOf('PARENT') >= 0) return false;
  if (user.roleCodes.indexOf('TEACHER') >= 0 && before.teacherId) return String(before.teacherId) === String(user.teacherId);
  return true;
}

function tableHasStudentId_(tableName) {
  return ARAMS_SCHEMA[tableName] && ARAMS_SCHEMA[tableName].indexOf('studentId') >= 0;
}

function getRestrictedFieldsForUser_(tableName, user) {
  const roles = user && Array.isArray(user.roleCodes) ? user.roleCodes : [];
  if (roles.indexOf('SUPER_ADMIN') >= 0 || roles.indexOf('ADMIN') >= 0) return [];
  const restricted = [];
  if (tableName === 'STUDENTS') {
    const registrarOrExecutive = ['REGISTRAR', 'PRINCIPAL', 'ACADEMIC_VICE_DIRECTOR'].some(function (role) {
      return roles.indexOf(role) >= 0;
    });
    if (!registrarOrExecutive) {
      restricted.push('nationalId', 'religion', 'ethnicity', 'bloodGroup');
    }
    if (roles.indexOf('GUIDANCE') < 0 && !registrarOrExecutive) {
      restricted.push('medicalNotes', 'specialNeeds');
    }
    if (roles.indexOf('TEACHER') >= 0 || roles.indexOf('ADVISOR') >= 0 || roles.indexOf('GUIDANCE') >= 0) {
      restricted.push('addressNo', 'villageNo', 'road', 'currentAddress', 'postalCode', 'emergencyContactName',
        'emergencyContactRelation', 'emergencyContactPhone');
    }
  }
  return restricted;
}

function sanitizeRecordForClient_(record, tableName, user) {
  const output = Object.assign({}, record);
  ['passwordHash', 'passwordSalt', 'deleteUrl'].forEach(function (field) { delete output[field]; });
  getRestrictedFieldsForUser_(tableName, user).forEach(function (field) { delete output[field]; });
  if (tableName === 'AUDIT_LOGS' && !(user.roleCodes.indexOf('SUPER_ADMIN') >= 0 || user.roleCodes.indexOf('ADMIN') >= 0)) delete output.ipAddress;
  return output;
}

function sanitizeUser_(user) {
  const output = Object.assign({}, user);
  delete output.passwordHash;
  delete output.passwordSalt;
  return output;
}

/* ========================================================================== *
 *  SECTION 12 - SHEET HELPERS AND FAST BATCH READ/WRITE
 * ========================================================================== */

function getDatabaseSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  let spreadsheetId = props.getProperty(SCRIPT_PROPERTY_KEYS.SPREADSHEET_ID);
  if (!spreadsheetId) {
    const created = SpreadsheetApp.create('ARAMS Database');
    spreadsheetId = created.getId();
    props.setProperty(SCRIPT_PROPERTY_KEYS.SPREADSHEET_ID, spreadsheetId);
  }
  return SpreadsheetApp.openById(spreadsheetId);
}

function getSheet_(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('SHEET_NOT_FOUND:' + sheetName);
  return sheet;
}

function getHeaders_(sheet) {
  const lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) return [];
  return sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0]
    .map(function (value) { return String(value || '').trim(); });
}

function getAllObjects_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];
  const values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  const headers = values.shift().map(function (value) { return String(value || '').trim(); });
  const rows = [];
  values.forEach(function (row) {
    if (row.every(function (cell) { return cell === '' || cell === null; })) return;
    const object = {};
    headers.forEach(function (header, index) {
      if (header) object[header] = serializeCell_(row[index]);
    });
    rows.push(object);
  });
  return rows;
}

function appendObject_(sheet, object) {
  const headers = getHeaders_(sheet);
  const row = headers.map(function (header) {
    return Object.prototype.hasOwnProperty.call(object, header) ? normalizeCellValue_(object[header]) : '';
  });
  const nextRow = Math.max(sheet.getLastRow() + 1, 2);
  sheet.getRange(nextRow, 1, 1, headers.length).setValues([row]);
  return nextRow;
}

function updateRecordById_(sheet, id, patch) {
  const rowInfo = findRowNumberById_(sheet, id);
  if (!rowInfo) throw new Error('RECORD_NOT_FOUND');
  const headers = getHeaders_(sheet);
  const rowRange = sheet.getRange(rowInfo.rowNumber, 1, 1, headers.length);
  const current = rowRange.getValues()[0];
  headers.forEach(function (header, index) {
    if (Object.prototype.hasOwnProperty.call(patch, header)) current[index] = normalizeCellValue_(patch[header]);
  });
  rowRange.setValues([current]);
  return true;
}

function findRecordById_(sheet, id) {
  if (!id) return null;
  return findRecordByField_(sheet, 'id', id);
}

function findRecordByField_(sheet, fieldName, value) {
  const rowInfo = findRowNumberByField_(sheet, fieldName, value);
  if (!rowInfo) return null;
  const headers = getHeaders_(sheet);
  const values = sheet.getRange(rowInfo.rowNumber, 1, 1, headers.length).getValues()[0];
  const result = {};
  headers.forEach(function (header, index) { if (header) result[header] = serializeCell_(values[index]); });
  return result;
}

function findRowNumberById_(sheet, id) {
  return findRowNumberByField_(sheet, 'id', id);
}

function findRowNumberByField_(sheet, fieldName, value) {
  const headers = getHeaders_(sheet);
  const columnIndex = headers.indexOf(fieldName);
  if (columnIndex < 0 || sheet.getLastRow() < 2) return null;
  const values = sheet.getRange(2, columnIndex + 1, sheet.getLastRow() - 1, 1).getDisplayValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(value)) return { rowNumber: i + 2 };
  }
  return null;
}

function matchesFilters_(row, filters) {
  if (!filters || typeof filters !== 'object') return true;
  return Object.keys(filters).every(function (key) {
    const expected = filters[key];
    if (expected === undefined || expected === null || expected === '') return true;
    const actual = row[key];
    if (Array.isArray(expected)) return expected.map(String).indexOf(String(actual)) >= 0;
    if (expected && typeof expected === 'object') {
      if (Object.prototype.hasOwnProperty.call(expected, 'contains')) return String(actual || '').toLowerCase().indexOf(String(expected.contains).toLowerCase()) >= 0;
      if (Object.prototype.hasOwnProperty.call(expected, 'from') && String(actual) < String(expected.from)) return false;
      if (Object.prototype.hasOwnProperty.call(expected, 'to') && String(actual) > String(expected.to)) return false;
      if (Object.prototype.hasOwnProperty.call(expected, 'ne') && String(actual) === String(expected.ne)) return false;
      if (Object.prototype.hasOwnProperty.call(expected, 'eq')) return String(actual) === String(expected.eq);
      return true;
    }
    return String(actual) === String(expected);
  });
}

function matchesQuery_(row, query, searchFields) {
  const fields = Array.isArray(searchFields) && searchFields.length ? searchFields : Object.keys(row);
  return fields.some(function (field) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) return false;
    return String(row[field] || '').toLowerCase().indexOf(query) >= 0;
  });
}

function isActiveRecord_(row) {
  return String(row.status || '').toUpperCase() !== ARAMS_CONFIG.SOFT_DELETE_STATUS &&
    String(row.status || 'ACTIVE').toUpperCase() === 'ACTIVE';
}

function countByField_(rows, field) {
  const output = {};
  rows.forEach(function (row) {
    const key = String(row[field] || 'ไม่ระบุ');
    output[key] = (output[key] || 0) + 1;
  });
  return output;
}

/* ========================================================================== *
 *  SECTION 13 - AUDIT LOGGING AND ERROR MAPPING
 * ========================================================================== */

function appendAuditLog_(user, details) {
  try {
    const sheet = getSheet_(getDatabaseSpreadsheet_(), 'AUDIT_LOGS');
    const actor = user || {};
    const object = Object.assign(baseRecord_(actor.userId || 'SYSTEM'), {
      actorUserId: actor.userId || 'SYSTEM',
      actorEmail: actor.email || '',
      actorName: actor.displayName || 'ระบบ',
      action: details.action || 'UNKNOWN',
      module: details.module || '',
      tableName: details.tableName || '',
      recordId: details.recordId || '',
      beforeJson: details.before ? JSON.stringify(details.before).slice(0, 45000) : '',
      afterJson: details.after ? JSON.stringify(details.after).slice(0, 45000) : '',
      reason: details.reason || '',
      ipAddress: details.ipAddress || '',
      userAgent: details.userAgent || ''
    });
    appendObject_(sheet, object);
  } catch (error) {
    console.error('appendAuditLog failed: ' + error);
  }
}

function auditSafeRecord_(record) {
  const output = Object.assign({}, record || {});
  ['passwordHash', 'passwordSalt', 'deleteUrl'].forEach(function (field) { delete output[field]; });
  return output;
}

function mapApiError_(error) {
  const message = String(error && error.message ? error.message : error || '');
  if (message === 'SESSION_EXPIRED') return apiError_('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  if (message === 'PASSWORD_CHANGE_REQUIRED') return apiError_('กรุณาเปลี่ยนรหัสผ่านก่อนเริ่มใช้งานระบบ');
  if (message === 'PERMISSION_DENIED') return apiError_('คุณไม่มีสิทธิ์ดำเนินการรายการนี้');
  if (message === 'MODULE_NOT_FOUND' || message === 'TABLE_NOT_ALLOWED') return apiError_('ไม่พบเมนูหรือชุดข้อมูลที่ต้องการ');
  if (message.indexOf('INVALID_FIELD:') === 0) return apiError_('ข้อมูลบางรายการไม่ถูกต้อง กรุณาตรวจสอบข้อมูลอีกครั้ง');
  if (message === 'DUPLICATE_RECORD') return apiError_('พบข้อมูลซ้ำในระบบ กรุณาตรวจสอบก่อนบันทึก');
  if (message === 'USE_USER_ADMIN_WORKFLOW') return apiError_('กรุณาใช้เมนูจัดการบัญชีผู้ใช้งาน');
  if (message === 'SYSTEM_TABLE_READ_ONLY') return apiError_('ไม่สามารถแก้ไขข้อมูลระบบรายการนี้ได้');
  if (message === 'USER_SECURITY_FIELDS_PROTECTED') return apiError_('กรุณาใช้เมนูจัดการบัญชีผู้ใช้งานสำหรับรายการนี้');
  if (message === 'RECORD_NOT_FOUND') return apiError_('ไม่พบข้อมูลที่ต้องการ');
  console.error('API internal error: ' + (error && error.stack ? error.stack : message));
  return apiError_('ไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง');
}

/* ========================================================================== *
 *  SECTION 14 - SECURITY, ID, AND DATA NORMALIZATION HELPERS
 * ========================================================================== */

function baseRecord_(actorId) {
  const now = nowIso_();
  return {
    id: createId_('REC'), createdAt: now, updatedAt: now,
    createdBy: actorId || 'SYSTEM', updatedBy: actorId || 'SYSTEM',
    status: 'ACTIVE', notes: ''
  };
}

function createId_(prefix) {
  const safePrefix = String(prefix || 'REC').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || 'REC';
  return safePrefix + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 18).toUpperCase();
}

function createRandomToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function ensureAppSecret_() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(SCRIPT_PROPERTY_KEYS.APP_SECRET)) {
    props.setProperty(SCRIPT_PROPERTY_KEYS.APP_SECRET, createRandomToken_());
  }
}

function hashPassword_(password, salt) {
  const secret = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTY_KEYS.APP_SECRET) || 'ARAMS-INSTALL-SECRET';
  let value = String(salt) + '|' + String(password) + '|' + secret;
  for (let i = 0; i < 4096; i++) value = sha256Hex_(value);
  return value;
}

function sha256Hex_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8);
  return bytes.map(function (byte) {
    const unsigned = (byte + 256) % 256;
    return ('0' + unsigned.toString(16)).slice(-2);
  }).join('');
}

function constantTimeEquals_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeCellValue_(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  // Prevent spreadsheet formula injection for untrusted text values.
  if (/^[=+@]/.test(text) || /^-[A-Za-z]/.test(text)) return "'" + text;
  return text;
}

function serializeCell_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, ARAMS_CONFIG.TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ss");
  return value === null || value === undefined ? '' : value;
}

function parseJsonArray_(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (ignore) { return []; }
}

function nowIso_() {
  return Utilities.formatDate(new Date(), ARAMS_CONFIG.TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ss");
}

function roundNumber_(value, decimals) {
  const factor = Math.pow(10, decimals || 0);
  return Math.round(Number(value || 0) * factor) / factor;
}

function isImageSignatureValid_(base64, mimeType) {
  try {
    const sample = Utilities.base64Decode(String(base64 || '').slice(0, 64));
    const byteAt = function (index) { return (sample[index] + 256) % 256; };
    if (mimeType === 'image/jpeg') return sample.length >= 3 && byteAt(0) === 0xFF && byteAt(1) === 0xD8 && byteAt(2) === 0xFF;
    if (mimeType === 'image/png') {
      return sample.length >= 8 && byteAt(0) === 0x89 && byteAt(1) === 0x50 && byteAt(2) === 0x4E &&
        byteAt(3) === 0x47 && byteAt(4) === 0x0D && byteAt(5) === 0x0A && byteAt(6) === 0x1A && byteAt(7) === 0x0A;
    }
    if (mimeType === 'image/webp') {
      return sample.length >= 12 && byteAt(0) === 0x52 && byteAt(1) === 0x49 && byteAt(2) === 0x46 &&
        byteAt(3) === 0x46 && byteAt(8) === 0x57 && byteAt(9) === 0x45 && byteAt(10) === 0x42 && byteAt(11) === 0x50;
    }
    return false;
  } catch (ignore) { return false; }
}

function sanitizeFileName_(name) {
  const base = String(name || 'image').replace(/\\/g, '/').split('/').pop();
  return base.replace(/[^A-Za-z0-9ก-๙._-]/g, '_').slice(0, 120) || 'image';
}

function createStudentCode_(academicYear, level) {
  const year = String(academicYear || new Date().getFullYear() + 543).replace(/[^0-9]/g, '').slice(-2);
  const levelCode = String(level || '').replace(/[^0-9]/g, '').slice(-1) || '0';
  const sheet = getSheet_(getDatabaseSpreadsheet_(), 'STUDENTS');
  const rows = getAllObjects_(sheet);
  let maxSequence = 0;
  rows.forEach(function (row) {
    const code = String(row.studentCode || '');
    if (code.indexOf(year + levelCode) === 0) {
      const seq = Number(code.slice(3));
      if (seq > maxSequence) maxSequence = seq;
    }
  });
  return year + levelCode + String(maxSequence + 1).padStart(4, '0');
}

function getSettingValue_(settingKey) {
  try {
    const row = findRecordByField_(getSheet_(getDatabaseSpreadsheet_(), 'SYSTEM_SETTINGS'), 'settingKey', settingKey);
    return row ? row.settingValue : '';
  } catch (ignore) { return ''; }
}

function csvEscape_(value) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\r?\n/g, ' ');
  return '"' + text.replace(/"/g, '""') + '"';
}

/* ========================================================================== *
 *  SECTION 15 - PERMISSION CATALOG AND DIAGNOSTIC UTILITIES
 * ========================================================================== */

function getPermissionCatalog_() {
  const modules = Object.keys(ARAMS_MODULES);
  const actions = ['read', 'create', 'update', 'delete', 'approve', 'submit', 'export'];
  const output = [];
  modules.forEach(function (moduleCode) {
    actions.forEach(function (actionCode) {
      output.push({
        permissionCode: moduleCode + ':' + actionCode,
        permissionName: ARAMS_MODULES[moduleCode].label + ' - ' + actionCode,
        moduleCode: moduleCode,
        actionCode: actionCode,
        description: 'สิทธิ์ ' + actionCode + ' สำหรับ ' + ARAMS_MODULES[moduleCode].label
      });
    });
  });
  return output;
}

/** Run manually to inspect sheet headers and missing schema columns. */
function validateAramsSchema() {
  const ss = getDatabaseSpreadsheet_();
  const report = [];
  Object.keys(ARAMS_SCHEMA).forEach(function (sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      report.push({ sheet: sheetName, exists: false, missingHeaders: ARAMS_SCHEMA[sheetName] });
      return;
    }
    const headers = getHeaders_(sheet);
    const missing = ARAMS_SCHEMA[sheetName].filter(function (name) { return headers.indexOf(name) < 0; });
    report.push({ sheet: sheetName, exists: true, columnCount: headers.length, missingHeaders: missing });
  });
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/** Re-run safely to add missing tabs/columns; existing data is retained. */
function repairAramsDatabase() {
  const ss = getDatabaseSpreadsheet_();
  const result = ensureAllSheets_(ss);
  seedDefaultRoles_(ss);
  seedDefaultSettings_(ss);
  seedDefaultSchoolProfile_(ss);
  seedDefaultGradeScale_(ss);
  SpreadsheetApp.flush();
  return {
    success: true,
    message: 'ตรวจสอบและปรับปรุงโครงสร้างฐานข้อมูลเรียบร้อยแล้ว',
    spreadsheetUrl: ss.getUrl(),
    createdSheets: result.createdSheets,
    repairedSheets: result.repairedSheets
  };
}

/**
 * Admin helper: create a user account from the Apps Script editor.
 * Example (run from editor after replacing the three values temporarily):
 *   createAramsUser('teacher@school.ac.th', 'รหัสผ่านที่ปลอดภัย123',
 *                   'ชื่อครู', ['TEACHER'], 'TEA-0001');
 * Remove the temporary invocation after use; never commit real passwords.
 */
function createAramsUser(email, password, displayName, roleCodes, teacherId, studentId, guardianId) {
  const normalizedEmail = normalizeEmail_(email);
  const cleanPassword = String(password || '');
  if (!normalizedEmail || cleanPassword.length < 12) throw new Error('กรุณาระบุอีเมลและรหัสผ่านอย่างน้อย 12 ตัวอักษร');
  const ss = getDatabaseSpreadsheet_();
  const sheet = getSheet_(ss, 'USERS');
  if (findRecordByField_(sheet, 'email', normalizedEmail)) throw new Error('มีอีเมลนี้ในระบบแล้ว');
  const roles = Array.isArray(roleCodes) ? roleCodes : [String(roleCodes || 'TEACHER')];
  const validRoles = getAllObjects_(getSheet_(ss, 'ROLES')).map(function (row) { return String(row.roleCode); });
  roles.forEach(function (role) { if (validRoles.indexOf(role) < 0) throw new Error('ไม่พบบทบาทผู้ใช้งาน: ' + role); });
  const salt = createRandomToken_();
  const user = Object.assign(baseRecord_('SYSTEM'), {
    email: normalizedEmail, username: normalizedEmail,
    passwordHash: hashPassword_(cleanPassword, salt), passwordSalt: salt,
    displayName: String(displayName || normalizedEmail),
    firstName: String(displayName || normalizedEmail), lastName: '', phone: '',
    roleCodes: JSON.stringify(roles), teacherId: teacherId || '',
    studentId: studentId || '', guardianId: guardianId || '',
    lastLoginAt: '', passwordChangedAt: nowIso_(), mustChangePassword: 'TRUE',
    failedLoginCount: 0, lockedUntil: ''
  });
  appendObject_(sheet, user);
  appendAuditLog_(null, { action: 'CREATE_USER', module: 'settings', tableName: 'USERS', recordId: user.id, after: { email: normalizedEmail, roleCodes: roles } });
  return { success: true, userId: user.id, email: normalizedEmail, roleCodes: roles };
}

/** Admin helper: update the role(s) assigned to a user. */
function setAramsUserRoles(userId, roleCodes) {
  const id = String(userId || '');
  const roles = Array.isArray(roleCodes) ? roleCodes : [String(roleCodes || '')];
  const ss = getDatabaseSpreadsheet_();
  const validRoles = getAllObjects_(getSheet_(ss, 'ROLES')).map(function (row) { return String(row.roleCode); });
  roles.forEach(function (role) { if (validRoles.indexOf(role) < 0) throw new Error('ไม่พบบทบาทผู้ใช้งาน: ' + role); });
  const sheet = getSheet_(ss, 'USERS');
  const user = findRecordById_(sheet, id);
  if (!user) throw new Error('ไม่พบผู้ใช้งาน');
  updateRecordById_(sheet, id, { roleCodes: JSON.stringify(roles), updatedAt: nowIso_(), updatedBy: 'SYSTEM' });
  invalidateUserSessions_(id);
  return { success: true, userId: id, roleCodes: roles };
}

/** Admin helper: deactivate a user account. */
function deactivateAramsUser(userId, reason) {
  const sheet = getSheet_(getDatabaseSpreadsheet_(), 'USERS');
  const user = findRecordById_(sheet, String(userId || ''));
  if (!user) throw new Error('ไม่พบผู้ใช้งาน');
  if (parseJsonArray_(user.roleCodes).indexOf('SUPER_ADMIN') >= 0) throw new Error('ไม่สามารถปิดใช้งานบัญชีผู้ดูแลระบบสูงสุดผ่านคำสั่งนี้ได้');
  updateRecordById_(sheet, user.id, { status: 'INACTIVE', updatedAt: nowIso_(), updatedBy: 'SYSTEM', notes: String(reason || '') });
  invalidateUserSessions_(user.id);
  return { success: true, userId: user.id };
}

/* ========================================================================== *
 *  SECTION 16 - END OF FILE
 * ========================================================================== */
