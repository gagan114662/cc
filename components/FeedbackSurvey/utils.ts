// Reconstructed phantom module. All importers in this folder use
// `import type`, so this file only needs to publish types.
//
// Observed usage (components/FeedbackSurvey/*):
//   - FeedbackSurveyResponse is passed to onSelect/handleSelect and compared
//     against the literals 'dismissed' | 'bad' | 'fine' | 'good'
//     (FeedbackSurveyView.tsx maps digit inputs to these literals;
//      useFeedbackSurvey.tsx gates transcript prompts on 'bad' / 'good').
//   - FeedbackSurveyType is used as a surveyType parameter defaulting to
//     'session'. useMemorySurvey emits survey_type: 'memory';
//     usePostCompactSurvey emits survey_type: 'post_compact'.

export type FeedbackSurveyResponse = 'dismissed' | 'bad' | 'fine' | 'good'

export type FeedbackSurveyType = 'session' | 'memory' | 'post_compact'
