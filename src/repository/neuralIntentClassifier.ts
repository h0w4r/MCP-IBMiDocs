import type { AssistOptions, AssistRetrievalAxis, AssistTaskFamily, DocsIntent } from "../types.js";
import {
  cosineSimilarity,
  embedTexts,
  semanticPassageText,
  semanticQueryText
} from "./neuralEmbeddings.js";

interface NeuralAssistPrototype {
  id: string;
  title: string;
  body: string;
  intent: DocsIntent;
  family: AssistTaskFamily;
  axes: AssistRetrievalAxis[];
  language?: string;
  category?: string;
  signals: string[];
  queries: string[];
}

export interface NeuralAssistIntentProfile {
  intent: DocsIntent;
  family: AssistTaskFamily;
  axes: AssistRetrievalAxis[];
  language?: string;
  category?: string;
  confidence: "alta" | "media" | "baja";
  score: number;
  matchedPrototype: string;
  signals: string[];
  queries: string[];
  localArtifacts: string[];
  generalizedQuestion: string;
  candidates: Array<{ id: string; score: number; family: AssistTaskFamily; intent: DocsIntent }>;
}

const LOCAL_ARTIFACT_STOPWORDS = new Set([
  "AS400",
  "CL",
  "CLLE",
  "COBOL",
  "COMMIT",
  "CPF",
  "ACTGRP",
  "ALWNULL",
  "ALWRINZ",
  "BNDDIR",
  "CURLIB",
  "CVTOPT",
  "DATEYY",
  "DBGENCKEY",
  "DBGVIEW",
  "DEBUGIO",
  "DEFAULT",
  "DEFINE",
  "DDS",
  "DSPF",
  "ENBPFRCOL",
  "ENTMOD",
  "EVENTF",
  "EXPDDS",
  "EXPORT",
  "F",
  "FIXNBR",
  "GENLVL",
  "ILE",
  "IBM",
  "IBMI",
  "INCDIR",
  "INCLUDE",
  "INDENT",
  "INFOSTMF",
  "JOB",
  "JOBLOG",
  "LANGID",
  "LF",
  "LICOPT",
  "LIKEREC",
  "MODULE",
  "NODEBUGIO",
  "NOEVENTF",
  "NOEXPDDS",
  "NOSECLVL",
  "NOSHOWCPY",
  "NOSHOWSKP",
  "NOSRCSTMT",
  "NOXREF",
  "OPTIMIZ",
  "OPTIMIZE",
  "OPTION",
  "OUTPUT",
  "PF",
  "PGMINFO",
  "PPGENOPT",
  "PPMINOUTLN",
  "PPSRCSFILE",
  "PPSRCSMBR",
  "PPSRCSTMF",
  "PRFDTA",
  "QSYS2",
  "REPLACE",
  "REQPREXP",
  "RPGPPOPT",
  "RPG",
  "RPGLE",
  "OVERLAY",
  "SBMJOB",
  "SELECT",
  "SECLVL",
  "SHOWCPY",
  "SHOWSKP",
  "SFL",
  "SFLCTL",
  "SFLDSP",
  "SFLPAG",
  "SFLSIZ",
  "SFLCLR",
  "SFLEND",
  "SQL",
  "SQLCODE",
  "SQLRPGLE",
  "SQLSTATE",
  "SOURCE",
  "SRCFILE",
  "SRCMBR",
  "SRCMBRTXT",
  "SRCSTMF",
  "SRCSTMT",
  "SRTSEQ",
  "STGMDL",
  "TGTCCSID",
  "TGTRLS",
  "TRUNCNBR",
  "UPDATE",
  "USRPRF",
  "WINDOW",
  "WRITE",
  "WRKJOBSCDE"
]);

const IBM_I_COMMAND_PREFIXES = [
  "add",
  "chg",
  "crt",
  "dlt",
  "dsp",
  "end",
  "mon",
  "rmv",
  "rtv",
  "sbm",
  "snd",
  "str",
  "wrk"
];

const IBM_I_COMMAND_PATTERN = new RegExp(`^(${IBM_I_COMMAND_PREFIXES.join("|")})[a-z0-9]{2,}$`, "i");
const MESSAGE_ID_PATTERN = /^(CPF|MCH|RNF|SQL|CPD)\d{4,5}$/i;

const PROTOTYPES: NeuralAssistPrototype[] = [
  {
    id: "job-schedule-execution-analysis",
    title: "IBM i job schedule and execution order analysis",
    body: [
      "The user wants to verify whether a local program, CL procedure, RPG program, batch process or liquidation process runs before or after another process.",
      "Do not create a program. Do not compile. This is operational evidence gathering.",
      "Use IBM i job scheduler and scheduled job entries: WRKJOBSCDE Work with Job Schedule Entries, ADDJOBSCDE, CHGJOBSCDE, RMVJOBSCDE, SBMJOB schedule date and time.",
      "Combine documented scheduler commands with source review of CL or RPG CALL/SBMJOB sequencing and joblog evidence."
    ].join(" "),
    intent: "explain_topic",
    family: "work_management",
    axes: ["administration", "syntax", "code"],
    language: "CLLE",
    category: "cl-clle",
    signals: ["neural-job-schedule", "work-management", "execution-order", "scheduled-job"],
    queries: [
      "WRKJOBSCDE Work with Job Schedule Entries",
      "ADDJOBSCDE Add Job Schedule Entry",
      "CHGJOBSCDE Change Job Schedule Entry",
      "RMVJOBSCDE Remove Job Schedule Entry",
      "SBMJOB schedule date time",
      "IBM i job schedule entries",
      "CL program SBMJOB scheduled job sequencing"
    ]
  },
  {
    id: "source-program-dependency-analysis",
    title: "IBM i source and program dependency analysis",
    body: [
      "The user wants to know which programs use or write a local physical file, table, field, member or object.",
      "Generalize local object names and explain how to inspect dependencies using program references, database relations, source physical files and catalog metadata.",
      "Use DSPPGMREF Display Program References, DSPDBR Display Database Relations, source search across RPG, SQLRPGLE and CL, logical files, physical files and key fields."
    ].join(" "),
    intent: "explain_topic",
    family: "db2_catalog_query",
    axes: ["database", "code", "syntax"],
    category: "sql-db2-for-i",
    signals: ["neural-source-dependency", "program-references", "database-relations", "source-search"],
    queries: [
      "DSPPGMREF Display Program References",
      "Display Program References IBM i",
      "DSPDBR Display Database Relations",
      "Db2 for i catalog views object dependencies",
      "QSYS2 SYSCOLUMNS column metadata",
      "QSYS2 SYSTABLES table metadata",
      "source physical file search RPG SQLRPGLE CL"
    ]
  },
  {
    id: "rpg-native-file-io",
    title: "ILE RPG native file input output and file specifications",
    body: [
      "The user asks how to interpret native RPG file operations such as WRITE, UPDATE, READ, CHAIN and F-spec or DCL-F declarations against physical files and logical files.",
      "Explain file specification, update-capable files, record formats, key fields and logical file access path implications."
    ].join(" "),
    intent: "syntax_lookup",
    family: "db2_catalog_query",
    axes: ["code", "syntax", "database"],
    language: "RPGLE",
    category: "ile-rpg",
    signals: ["neural-rpg-native-io", "file-specification", "write-update", "logical-file"],
    queries: [
      "RPG file specification F-spec",
      "WRITE operation code RPG",
      "UPDATE operation code RPG",
      "DCL-F file declaration ILE RPG",
      "DDS logical file key fields",
      "DSPDBR logical physical file relations"
    ]
  },
  {
    id: "db2-catalog-metadata",
    title: "Db2 for i catalog and metadata query guidance",
    body: [
      "The user asks for catalog views, metadata, tables, columns, schemas, fields or SQL read-only discovery on IBM i.",
      "Use QSYS2 catalog views, SYSCOLUMNS, SYSTABLES, SYSINDEXES and safe read-only SQL validation."
    ].join(" "),
    intent: "explain_topic",
    family: "db2_catalog_query",
    axes: ["database", "syntax"],
    category: "sql-db2-for-i",
    signals: ["neural-db2-catalog", "metadata", "qsys2"],
    queries: [
      "Db2 for i catalog views",
      "QSYS2 catalog views",
      "QSYS2 SYSCOLUMNS column metadata",
      "QSYS2 SYSTABLES table metadata",
      "SYSINDEXES catalog view"
    ]
  },
  {
    id: "rpg-sql-date-time-conversion",
    title: "RPG SQLRPGLE date time timestamp numeric packed decimal conversion",
    body: [
      "The user asks about time, date, timestamp, ISO0, HHMMSS, packed decimal, decimal conversion, %TIME, %DATE, %TIMESTAMP, %DEC, SET OPTION, SQLCODE or embedded SQL.",
      "Give precise conversion guidance and validation for RPG and SQLRPGLE."
    ].join(" "),
    intent: "syntax_lookup",
    family: "date_time_conversion",
    axes: ["datatype", "syntax", "compile", "database"],
    language: "SQLRPGLE",
    category: "ile-rpg",
    signals: ["neural-date-time-conversion", "packed-decimal", "sqlrpgle"],
    queries: [
      "%TIME built-in function",
      "Time Data Type RPG",
      "TIMFMT Time Format keyword physical logical files",
      "%DEC Convert to Packed Decimal Format date time timestamp",
      "Date time or timestamp expression %DEC",
      "SET OPTION SQL",
      "SQLCA SQLCODE SQLSTATE embedded SQL RPG",
      "INSERT statement SQL",
      "UPDATE statement SQL",
      "SELECT statement SQL"
    ]
  },
  {
    id: "rpgle-compile-guidance",
    title: "ILE RPG RPGLE compile command guidance",
    body: [
      "The user wants compile commands or build guidance for RPGLE modules or programs.",
      "Use CRTRPGMOD, CRTBNDRPG, DBGVIEW, TGTRLS, OPTION and related ILE compile options."
    ].join(" "),
    intent: "compile_guidance",
    family: "create_program",
    axes: ["compile", "syntax"],
    language: "RPGLE",
    category: "ile-rpg",
    signals: ["neural-rpgle-compile", "crtrpgmod", "crtbndrpg"],
    queries: [
      "CRTRPGMOD Command",
      "CRTBNDRPG Command",
      "RPGLE compile options",
      "DBGVIEW parameter CRTBNDRPG CRTRPGMOD"
    ]
  },
  {
    id: "sqlrpgle-compile-guidance",
    title: "SQLRPGLE embedded SQL compile and precompiler guidance",
    body: [
      "The user wants SQLRPGLE compile guidance, embedded SQL, EXEC SQL, CRTSQLRPGI, RPGPPOPT, COMMIT, SQLCODE, SQLSTATE or copy include handling."
    ].join(" "),
    intent: "compile_guidance",
    family: "create_program",
    axes: ["compile", "database", "syntax"],
    language: "SQLRPGLE",
    category: "sql-db2-for-i",
    signals: ["neural-sqlrpgle-compile", "embedded-sql", "crtsqlrpgi"],
    queries: [
      "CRTSQLRPGI command",
      "SQLRPGLE embedded SQL RPG",
      "RPGPPOPT SQL precompiler",
      "Using /COPY /INCLUDE in Source Files with Embedded SQL",
      "SET OPTION SQL"
    ]
  },
  {
    id: "clle-program-guidance",
    title: "CLLE control language program guidance",
    body: [
      "The user wants to create or correct a CLLE program, control language procedure, MONMSG, SNDPGMMSG, RTVJOBA or CRTBNDCL.",
      "Use CL syntax, CL commands, variables, messages and compile command guidance."
    ].join(" "),
    intent: "compile_guidance",
    family: "create_program",
    axes: ["compile", "syntax"],
    language: "CLLE",
    category: "cl-clle",
    signals: ["neural-clle", "control-language"],
    queries: [
      "CL programs and procedures",
      "CRTBNDCL command",
      "MONMSG command",
      "SNDPGMMSG command",
      "RTVJOBA command"
    ]
  },
  {
    id: "dds-display-subfile-diagnostic",
    title: "DDS display file subfile diagnostic and design",
    body: [
      "The user asks about DDS display files, DSPF, subfiles, SFLCTL, SFLDSP, SFLPAG, SFLSIZ, WINDOW, OVERLAY, command keys, indicators or display file compile diagnostics."
    ].join(" "),
    intent: "compile_guidance",
    family: "design_display_or_report",
    axes: ["syntax", "compile", "code"],
    language: "DDS",
    category: "dds",
    signals: ["neural-dds-display", "subfile", "dspf"],
    queries: [
      "DDS subfile display files",
      "SFLSIZ SFLPAG keyword for display files",
      "SFLRCDNBR Subfile Record Number keyword",
      "WINDOW keyword for display files",
      "CRTDSPF command"
    ]
  },
  {
    id: "dds-physical-logical-file-design",
    title: "DDS physical logical file design",
    body: [
      "The user wants to define DDS physical files or logical files, PF, LF, record formats, keys, UNIQUE, FIFO, LIFO, FCFO or CRTPF CRTLF commands."
    ].join(" "),
    intent: "explain_topic",
    family: "design_dds_file",
    axes: ["syntax", "compile", "database"],
    language: "DDS",
    category: "dds",
    signals: ["neural-dds-file", "physical-file", "logical-file"],
    queries: [
      "Defining a physical file using DDS",
      "DDS for physical and logical files",
      "DDS keywords physical logical files",
      "UNIQUE keyword physical logical files",
      "CRTPF command",
      "CRTLF command"
    ]
  },
  {
    id: "dds-display-keyword-lookup",
    title: "DDS display file keyword redisplay subfile message keyword lookup",
    body: [
      "The user asks a short interview-style or natural-language question about a DDS display file keyword.",
      "They may say key word, keyword, screen redisplay, re-display, restore display, subfile control, message subfile, function key, error message or display format without naming DDS explicitly.",
      "This is not an IBM i message diagnostic. It is a display file DDS keyword lookup.",
      "Retrieve RSTDSP, USRRSTDSP, SFLDSP, SFLDSPCTL, SFLMSGKEY, SFLPGMQ, SFLMSGRCD, ERRMSG, ERRMSGID, CFxx and CAxx documentation."
    ].join(" "),
    intent: "syntax_lookup",
    family: "design_display_or_report",
    axes: ["syntax", "code"],
    language: "DDS",
    category: "dds",
    signals: ["neural-dds-keyword", "display-file-keyword", "screen-redisplay", "subfile-message"],
    queries: [
      "DDS display file and subfile keywords",
      "RSTDSP restore display keyword DDS display file",
      "USRRSTDSP User Restore Display keyword for display files",
      "SFLDSPCTL subfile control display keyword",
      "SFLMSGKEY SFLPGMQ SFLMSGRCD message subfile keywords",
      "ERRMSG ERRMSGID display file keywords",
      "CFxx CAxx function key DDS keywords"
    ]
  },
  {
    id: "rpg-operation-code-lookup",
    title: "RPG operation code SETLL EXFMT CAT RETURN VARYING lookup",
    body: [
      "The user asks what an RPG operation code, indicator or keyword does.",
      "They may ask interview-style questions about SETLL, EXFMT, CAT, RETURN, LR, SETON LR, VARYING, CHAIN, READE or file positioning.",
      "This is RPG syntax and language reference lookup, not generic IBM i command lookup.",
      "Retrieve ILE RPG operation code reference and the derived operation-code semantic bundle."
    ].join(" "),
    intent: "syntax_lookup",
    family: "command_lookup",
    axes: ["syntax", "code"],
    language: "RPGLE",
    category: "ile-rpg",
    signals: ["neural-rpg-opcode", "setll", "exfmt", "varying", "lr-indicator"],
    queries: [
      "ILE RPG operation codes indicators string operations",
      "SETLL Set Lower Limit RPG operation code",
      "EXFMT Write Then Read Format RPG operation code",
      "CAT Concatenate Two Strings RPG operation code",
      "RETURN operation RPG LR indicator",
      "VARYING keyword RPG variable length field",
      "%FOUND SETLL CHAIN RPG"
    ]
  },
  {
    id: "cl-variable-types-lookup",
    title: "CL variable declaration types character decimal logical lookup",
    body: [
      "The user asks which variable types are available in CL or how CL variables are declared.",
      "This is CL syntax reference for DCL, TYPE(*CHAR), TYPE(*DEC), TYPE(*LGL), integer, pointer and declared variables.",
      "Retrieve CL variable declarations and examples, not database overrides or message diagnostics."
    ].join(" "),
    intent: "syntax_lookup",
    family: "command_lookup",
    axes: ["syntax", "code"],
    language: "CLLE",
    category: "cl-clle",
    signals: ["neural-cl-variables", "dcl", "cl-variable-types"],
    queries: [
      "Declaring variables to a CL program or procedure",
      "Variables in CL commands",
      "DCL TYPE(*CHAR) TYPE(*DEC) TYPE(*LGL) CL variables",
      "CL variable value character packed decimal logical integer pointer",
      "CL commands variables labels messages database overrides"
    ]
  },
  {
    id: "cl-send-message-command-lookup",
    title: "CL send message commands SNDPGMMSG SNDUSRMSG SNDMSG lookup",
    body: [
      "The user asks how to code CL to send a message or which CL commands send program, user, informational, completion or escape messages.",
      "This is CL command reference for SNDPGMMSG, SNDUSRMSG and SNDMSG.",
      "Do not classify as message diagnostic unless a CPF, RNF, SQL, MCH or CPD message ID is being diagnosed."
    ].join(" "),
    intent: "syntax_lookup",
    family: "command_lookup",
    axes: ["syntax", "code", "message"],
    language: "CLLE",
    category: "cl-clle",
    signals: ["neural-cl-send-message", "sndpgmmsg", "sndusrmsg", "sndmsg"],
    queries: [
      "Commands used to send messages to a system user",
      "SNDPGMMSG Send Program Message command",
      "SNDUSRMSG Send User Message command",
      "SNDMSG Send Message command",
      "CL commands variables labels messages database overrides"
    ]
  },
  {
    id: "cl-command-label-lookup",
    title: "CL command label GOTO CMDLBL lookup",
    body: [
      "The user asks what a command label is in CL or how GOTO transfers control to a labeled command.",
      "This is CL syntax reference for command labels, GOTO and CMDLBL."
    ].join(" "),
    intent: "syntax_lookup",
    family: "command_lookup",
    axes: ["syntax", "code"],
    language: "CLLE",
    category: "cl-clle",
    signals: ["neural-cl-command-label", "goto", "cmdlbl"],
    queries: [
      "GOTO command and command labels in a CL program or procedure",
      "GOTO CMDLBL label CL command",
      "command label CL program procedure",
      "CL commands variables labels messages database overrides"
    ]
  },
  {
    id: "cl-override-open-query-message-lookup",
    title: "CL database file override and open query file OVRDBF OPNQRYF lookup",
    body: [
      "The user asks a CL interview-style or natural-language question specifically about database file overrides, OVRDBF, OPNQRYF, open query file or override with database file.",
      "They may ask what command must be run before OPNQRYF or what OVRDBF stands for.",
      "This is CL database-file command reference lookup, not CL variables, labels or send-message commands."
    ].join(" "),
    intent: "syntax_lookup",
    family: "command_lookup",
    axes: ["syntax", "code"],
    language: "CLLE",
    category: "cl-clle",
    signals: ["neural-cl-file-override", "opnqryf", "ovrdbf"],
    queries: [
      "OVRDBF Override with Database File command",
      "OPNQRYF Open Query File command",
      "OVRDBF before OPNQRYF CL",
      "IBM i database file member dependency commands OVRDBF OPNQRYF",
      "Opening and closing files in a CL program or procedure"
    ]
  },
  {
    id: "ile-module-service-program-lookup",
    title: "ILE module service program binding directory signature lookup",
    body: [
      "The user asks about ILE modules, service programs, binding, signatures, exports, CALLP or whether a module can be called directly.",
      "Explain that modules are bound into programs or service programs, and service programs export reusable procedures.",
      "Retrieve ILE module and service program documentation."
    ].join(" "),
    intent: "explain_topic",
    family: "create_program",
    axes: ["syntax", "compile", "code"],
    language: "RPGLE",
    category: "ile-rpg",
    signals: ["neural-ile-module", "service-program", "binding", "signature"],
    queries: [
      "ILE modules service programs binding signatures",
      "Can a module be called directly ILE RPG",
      "CRTRPGMOD CRTPGM CRTSRVPGM module service program",
      "Binding directory IBM i ILE RPG",
      "Binder language service program signature",
      "CALLP procedure service program"
    ]
  },
  {
    id: "terminal-emulator-function-key-lookup",
    title: "IBM i terminal emulator TN5250 function key keyboard map lookup",
    body: [
      "The user asks about terminal emulator behavior, F4/PF4 prompt, TN5250/TN3270, keyboard maps or command key mapping.",
      "Generalize emulator-specific names and retrieve IBM i keyboard mapping or terminal session guidance."
    ].join(" "),
    intent: "explain_topic",
    family: "general_explanation",
    axes: ["administration", "syntax"],
    category: "administration",
    signals: ["neural-terminal-emulator", "function-key", "keyboard-map", "tn5250"],
    queries: [
      "IBM i terminal emulation keyboard maps function keys",
      "TN5250 TN3270 IBM i terminal emulator",
      "PF4 F4 prompt keyboard mapping IBM i",
      "CHGKBDMAP DSPKBDMAP SETKBDMAP keyboard map",
      "CMDKBD keyboard command IBM i"
    ]
  },
  {
    id: "rpg-language-history-lookup",
    title: "RPG language versions RPG III RPG IV RPG400 ILE RPG",
    body: [
      "The user asks about earlier versions of RPG, historical RPG generations, RPG III, RPG/400, RPG IV, ILE RPG, fixed form or free form.",
      "Retrieve RPG language evolution documentation and distinguish historical names."
    ].join(" "),
    intent: "explain_topic",
    family: "general_explanation",
    axes: ["primary", "syntax"],
    language: "RPGLE",
    category: "ile-rpg",
    signals: ["neural-rpg-history", "rpg-iii", "rpg-iv", "ile-rpg"],
    queries: [
      "RPG language evolution historical versions",
      "RPG III RPG IV RPG400 ILE RPG",
      "ILE RPG language reference fixed form free form",
      "earlier versions of RPG"
    ]
  },
  {
    id: "message-diagnostic",
    title: "IBM i message diagnostic RNF CPF MCH SQL CPD",
    body: [
      "The user asks about an IBM i message id, compiler diagnostic, joblog message, second level text, cause, recovery or error family.",
      "Diagnose RNF, CPF, MCH, SQL or CPD messages with documented cause and recovery."
    ].join(" "),
    intent: "message_diagnostic",
    family: "message_diagnostic",
    axes: ["message", "syntax"],
    signals: ["neural-message-diagnostic"],
    queries: [
      "RPG Messages",
      "IBM i messages and codes",
      "CPF messages",
      "MCH messages",
      "SQL messages",
      "CPD messages"
    ]
  },
  {
    id: "command-lookup",
    title: "IBM i command syntax parameter lookup",
    body: [
      "The user asks for a command, syntax, parameter, operand, option, example or command reference.",
      "Return command topic, parameters, syntax, examples and notes."
    ].join(" "),
    intent: "syntax_lookup",
    family: "command_lookup",
    axes: ["syntax"],
    signals: ["neural-command-lookup"],
    queries: [
      "IBM i commands",
      "CL command finder",
      "command parameters syntax examples"
    ]
  },
  {
    id: "object-lock-analysis",
    title: "IBM i object record lock analysis",
    body: [
      "The user asks about locks, object locks, member locks, record lock, locked record, WRKOBJLCK, lock states, owner job or RPG status 1218."
    ].join(" "),
    intent: "explain_topic",
    family: "object_lock_analysis",
    axes: ["administration", "syntax", "code"],
    category: "cl-clle",
    signals: ["neural-object-lock", "work-management"],
    queries: [
      "WRKOBJLCK Work with Object Locks",
      "Displaying the lock states for objects WRKOBJLCK",
      "RPG record lock status 1218",
      "record lock %STATUS %ERROR RPG",
      "Releasing record locks"
    ]
  },
  {
    id: "work-management",
    title: "IBM i work management active jobs joblog submitted jobs debugging",
    body: [
      "The user asks about active jobs, job queues, submitted jobs, joblog, DSPJOB, WRKJOB, WRKACTJOB, WRKSBMJOB, STRSRVJOB, STRDBG or batch debugging."
    ].join(" "),
    intent: "explain_topic",
    family: "work_management",
    axes: ["administration", "syntax"],
    category: "cl-clle",
    signals: ["neural-work-management"],
    queries: [
      "WRKACTJOB Work with Active Jobs",
      "DSPJOB Display Job",
      "WRKJOB Work with Job",
      "Displaying a job log DSPJOBLOG WRKJOBLOG",
      "Debugging batch jobs",
      "WRKSBMJOB Work with Submitted Jobs"
    ]
  },
  {
    id: "journaling-command-family",
    title: "IBM i journaling journal receiver and journaled changes command family",
    body: [
      "The user asks about journaling commands, journal receivers, journal entries, journaled changes, database file journaling or commands to start and end journaling for physical files.",
      "This is not SQLRPGLE compile guidance even if a language hint is present. It is a command lookup and operational documentation task.",
      "Retrieve the command family for APYJRNCHG, CHGJRN, CMPJRNIMG, CRTJRN, CRTJRNRCV, DLTJRN, DLTJRNRCV, DSPJRN, DSPJRNRCVA, ENDJRNPF, RCVJRNE, RMVJRNCHG, RTVJRNE, SNDJRNE, STRJRNPF, WRKJRN and WRKJRNA."
    ].join(" "),
    intent: "syntax_lookup",
    family: "command_lookup",
    axes: ["administration", "syntax"],
    category: "cl-clle",
    signals: ["neural-journaling", "journal-receiver", "journaled-changes", "command-family"],
    queries: [
      "IBM i journaling commands",
      "journal receiver commands IBM i",
      "journaled changes commands APYJRNCHG RMVJRNCHG",
      "CRTJRN CRTJRNRCV DSPJRN STRJRNPF ENDJRNPF commands",
      "derived semantic command groups journaling",
      "CL command finder journaling commands"
    ]
  },
  {
    id: "code-review",
    title: "IBM i source code review and bug correction",
    body: [
      "The user provides code and wants to review, correct, validate, refactor or diagnose source against IBM i documentation."
    ].join(" "),
    intent: "code_review",
    family: "code_review",
    axes: ["code", "syntax"],
    signals: ["neural-code-review"],
    queries: [
      "ILE RPG Reference",
      "CL programs and procedures",
      "SQLRPGLE embedded SQL RPG",
      "DDS keywords"
    ]
  },
  {
    id: "version-check",
    title: "IBM i release version comparison availability",
    body: [
      "The user asks whether a command, keyword, feature or behavior exists in IBM i 7.3, 7.4, 7.5 or 7.6, or asks to compare releases."
    ].join(" "),
    intent: "version_question",
    family: "version_check",
    axes: ["version", "syntax"],
    signals: ["neural-version-check"],
    queries: [
      "IBM i 7.3 7.4 7.5 7.6 release documentation",
      "version comparison IBM i command keyword"
    ]
  },
  {
    id: "general-explanation",
    title: "General IBM i documentation explanation",
    body: "The user asks a general IBM i AS400 question and needs documented explanation with citations and evidence.",
    intent: "explain_topic",
    family: "general_explanation",
    axes: ["primary"],
    signals: ["neural-general"],
    queries: ["IBM i documentation"]
  }
];

let prototypeVectorPromise: Promise<Float32Array[]> | undefined;

export async function classifyAssistIntentNeural(options: AssistOptions): Promise<NeuralAssistIntentProfile> {
  const localArtifacts = extractLocalArtifactTermsForAssist(options.question);
  const generalizedQuestion = generalizeLocalArtifacts(options.question, localArtifacts);
  const query = [
    "Classify this IBM i / AS400 documentation task.",
    `Question: ${generalizedQuestion}`,
    "Classify intent from the question first; language/category hints are secondary execution context, not the task itself.",
    options.code ? `Code is present and should be reviewed against documentation.` : ""
  ].filter(Boolean).join("\n");
  const [queryVector] = await embedTexts([semanticQueryText(query)], { localOnly: true, kind: "query" });
  if (!queryVector) return defaultProfile(localArtifacts, generalizedQuestion);

  const prototypeVectors = await getPrototypeVectors();
  const ranked = PROTOTYPES.map((prototype, index) => ({
    prototype,
    score: cosineSimilarity(queryVector, prototypeVectors[index] ?? new Float32Array())
  })).sort((a, b) => b.score - a.score);

  const best = ranked[0]?.prototype ?? PROTOTYPES[PROTOTYPES.length - 1];
  const bestScore = ranked[0]?.score ?? 0;
  const confidence: NeuralAssistIntentProfile["confidence"] = bestScore >= 0.72 ? "alta" : bestScore >= 0.58 ? "media" : "baja";
  const related = ranked.slice(1, 4)
    .filter((item) => item.prototype.family === best.family || item.prototype.intent === best.intent)
    .filter((item) => item.score >= bestScore - 0.06)
    .flatMap((item) => item.prototype.queries.slice(0, 3));
  return {
    intent: best.intent,
    family: best.family,
    axes: [...new Set(best.axes)],
    language: best.language,
    category: best.category,
    confidence,
    score: Math.round(bestScore * 100000) / 100000,
    matchedPrototype: best.id,
    signals: [...new Set([...best.signals, ...ranked.slice(1, 3).flatMap((item) => item.prototype.signals.slice(0, 2))])],
    queries: [...new Map([...best.queries, ...related].map((queryText) => [queryText.toLowerCase(), queryText])).values()].slice(0, 14),
    localArtifacts,
    generalizedQuestion,
    candidates: ranked.slice(0, 6).map((item) => ({
      id: item.prototype.id,
      score: Math.round(item.score * 100000) / 100000,
      family: item.prototype.family,
      intent: item.prototype.intent
    }))
  };
}

export function extractLocalArtifactTermsForAssist(question: string): string[] {
  const contextSuggestsLocalObjects = /\b(programa|program|tabla|table|campo|field|archivo|file|fuente|source|objeto|object|proceso|process|miembro|member|biblioteca|library)\b/i.test(question);
  const tokens = question.match(/\b[A-Z][A-Z0-9_]{4,}\b/g) ?? [];
  return [...new Set(tokens.filter((token) => {
    const upper = token.toUpperCase();
    if (LOCAL_ARTIFACT_STOPWORDS.has(upper)) return false;
    if (MESSAGE_ID_PATTERN.test(upper)) return false;
    if (IBM_I_COMMAND_PATTERN.test(upper)) return false;
    if (/^Q[A-Z0-9_]+$/.test(upper) && upper.length <= 10) return false;
    if (/NOEXIST|FICT|FAKE|ZZZ/.test(upper)) return false;
    return contextSuggestsLocalObjects && (/\d/.test(upper) || upper.length >= 6);
  }))];
}

function getPrototypeVectors(): Promise<Float32Array[]> {
  prototypeVectorPromise ??= embedTexts(PROTOTYPES.map((prototype) => semanticPassageText({
    title: `${prototype.title} ${prototype.family} ${prototype.intent}`,
    body: prototype.body,
    category: prototype.category,
    language: prototype.language,
    breadcrumbs: prototype.signals
  })), { localOnly: true, kind: "passage" });
  return prototypeVectorPromise;
}

function generalizeLocalArtifacts(question: string, localArtifacts: string[]): string {
  let generalized = question;
  for (const artifact of localArtifacts) {
    generalized = generalized.replace(new RegExp(`\\b${escapeRegExp(artifact)}\\b`, "g"), localArtifactLabel(question, artifact));
  }
  return generalized;
}

function localArtifactLabel(question: string, artifact: string): string {
  const window = surroundingText(question, artifact, 60);
  if (/\b(campo|field|columna|column)\b/i.test(window)) return "campo local";
  if (/\b(tabla|table|archivo|file|pf|physical)\b/i.test(window)) return "tabla o archivo local";
  if (/\b(programa|program|cl|rpgle|sqlrpgle|proceso|process)\b/i.test(window)) return "programa o proceso local";
  if (/\b(miembro|member|fuente|source)\b/i.test(window)) return "miembro o fuente local";
  return "artefacto local del servidor";
}

function surroundingText(value: string, needle: string, radius: number): string {
  const index = value.indexOf(needle);
  if (index < 0) return value;
  return value.slice(Math.max(0, index - radius), Math.min(value.length, index + needle.length + radius));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultProfile(localArtifacts: string[], generalizedQuestion: string): NeuralAssistIntentProfile {
  return {
    intent: "explain_topic",
    family: "general_explanation",
    axes: ["primary"],
    confidence: "baja",
    score: 0,
    matchedPrototype: "general-explanation",
    signals: ["neural-general"],
    queries: ["IBM i documentation"],
    localArtifacts,
    generalizedQuestion,
    candidates: []
  };
}
