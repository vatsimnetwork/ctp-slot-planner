export const ROW_H       = 52;
export const HEADER_H    = 47 + 20;
export const TRACK_COLS  = ['#2783C5', '#29B473', '#2A3B90', '#E8543E', '#9B59B6', '#F39C12'];
export const BRACE_W     = 18;
export const TIME_W      = 0;
export const BRACE_GAP   = 0;
export const BRACE_COL_W = BRACE_W + 16;

export const DEFAULT_SIM_PARAMS = {
  IntendedSlotGenerationMode:                        'MaximizeSlots',
  DepartureTimeWindowOffsetSynchronizationLongitude: -30,
  SimulationAnalysisResolutionInMinutes:             2,
  ShouldSimulationUseActualWeatherForecastData:      false,
  IntendedDepartureTimeWindowOffsetsCalculationMode: 'EarliestRoutes',
  DepartureTimeWindowOffsetSynchronizationTimeOfDay: '1600z',
  CalculateThroughputDataOnlyForManuallyProvidedSectors: true,
  IntendedWaypointThroughputCalculationMode:         'FirstWaypointsOfNATRouteSegmentsOnly',
  ThresholdToCheckIfAirplaneIsCountedAtWaypointInNm: 5,
  CalculationFallbackGroundSpeed:                    300,
  HighSimulationAccuracy:                            false,
};
