import base64
import hashlib
import io
import struct
import sys
import time
import zipfile

from vtk.vtkCommonCore import vtkTypeUInt32Array, vtkTypeInt32Array
from vtk.vtkFiltersGeometry import vtkCompositeDataGeometryFilter
from vtk.vtkFiltersGeometry import vtkGeometryFilter
from vtk.vtkRenderingCore import vtkColorTransferFunction

# -----------------------------------------------------------------------------
# Python compatibility handling 2.6, 2.7, 3+
# -----------------------------------------------------------------------------

py3 = sys.version_info >= (3, 0)

if py3:
    def iteritems(d, **kwargs):
        return iter(d.items(**kwargs))
else:
    def iteritems(d, **kwargs):
        return d.iteritems(**kwargs)

if sys.version_info >= (2, 7):
    buffer = memoryview
    base64Encode = lambda x: base64.b64encode(x).decode('utf-8')
else:
    buffer = buffer
    base64Encode = lambda x: x.encode('base64')

# -----------------------------------------------------------------------------
# Array helpers
# -----------------------------------------------------------------------------

arrayTypesMapping = [
    ' ',  # VTK_VOID                0
    ' ',  # VTK_BIT                 1
    'b',  # VTK_CHAR                2
    'B',  # VTK_UNSIGNED_CHAR       3
    'h',  # VTK_SHORT               4
    'H',  # VTK_UNSIGNED_SHORT      5
    'i',  # VTK_INT                 6
    'I',  # VTK_UNSIGNED_INT        7
    'l',  # VTK_LONG                8
    'L',  # VTK_UNSIGNED_LONG       9
    'f',  # VTK_FLOAT               10
    'd',  # VTK_DOUBLE              11
    'L',  # VTK_ID_TYPE             12
    ' ',  # VTK_STRING              13
    ' ',  # VTK_OPAQUE              14
    ' ',  # UNDEFINED
    'l',  # VTK_LONG_LONG           16
    'L',  # VTK_UNSIGNED_LONG_LONG  17
]

javascriptMapping = {
    'b': 'Int8Array',
    'B': 'Uint8Array',
    'h': 'Int16Array',
    'H': 'UInt16Array',
    'i': 'Int32Array',
    'I': 'Uint32Array',
    'l': 'Int32Array',
    'L': 'Uint32Array',
    'f': 'Float32Array',
    'd': 'Float64Array'
}


def hashDataArray(dataArray):
    return hashlib.md5(buffer(dataArray)).hexdigest()


def getJSArrayType(dataArray):
    return javascriptMapping[arrayTypesMapping[dataArray.GetDataType()]]


def zipCompression(name, data):
    with io.BytesIO() as in_memory:
        with zipfile.ZipFile(in_memory, mode="w") as zf:
            zf.writestr('data/%s' % name,
                        data, zipfile.ZIP_DEFLATED)
        in_memory.seek(0)
        return in_memory.read()


def dataTableToList(dataTable):
    dataType = arrayTypesMapping[dataTable.GetDataType()]
    elementSize = struct.calcsize(dataType)
    nbValues = dataTable.GetNumberOfValues()
    nbComponents = dataTable.GetNumberOfComponents()
    nbytes = elementSize * nbValues
    if dataType != ' ':
        with io.BytesIO(buffer(dataTable)) as stream:
            data = list(struct.unpack(dataType*nbValues ,stream.read(nbytes)))
        return [data[idx*nbComponents:(idx+1)*nbComponents]
                    for idx in range(nbValues//nbComponents)]

# -----------------------------------------------------------------------------

def linspace(start, stop, num):
    delta = (stop - start)/(num-1)
    return [start + i*delta for i in range(num)]

# -----------------------------------------------------------------------------
# Convenience class for caching data arrays, storing computed sha sums, keeping
# track of valid actors, etc...
# -----------------------------------------------------------------------------


class SynchronizationContext():

    def __init__(self, id_root=None, debug=False):
        self.dataArrayCache = {}
        self.lastDependenciesMapping = {}
        self.ingoreLastDependencies = False
        self.idRoot = id_root
        self.debugSerializers = debug
        self.debugAll = debug

    def getReferenceId(self, instance):
        if not self.idRoot or (hasattr(instance, 'IsA') and instance.IsA('vtkCamera')):
            return getReferenceId(instance)
        else:
            return self.idRoot + getReferenceId(instance)

    def setIgnoreLastDependencies(self, force):
        self.ingoreLastDependencies = force

    def cacheDataArray(self, pMd5, data):
        self.dataArrayCache[pMd5] = data

    def getCachedDataArray(self, pMd5, binary=False, compression=False):
        cacheObj = self.dataArrayCache[pMd5]
        array = cacheObj['array']
        cacheTime = cacheObj['mTime']

        if cacheTime != array.GetMTime():
            if context.debugAll:
                print(' ***** ERROR: you asked for an old cache key! ***** ')

        if array.GetDataType() in (12, 16, 17):
            arraySize = array.GetNumberOfTuples() * array.GetNumberOfComponents()
            if array.GetDataType() in (12, 17):
                # IdType and unsigned long long need to be converted to Uint32
                newArray = vtkTypeUInt32Array()
            else:
                #  long long need to be converted to Int32
                newArray = vtkTypeInt32Array()
            newArray.SetNumberOfTuples(arraySize)
            for i in range(arraySize):
                newArray.SetValue(i, -1 if array.GetValue(i)
                                  < 0 else array.GetValue(i))
            pBuffer = buffer(newArray)
        else:
            pBuffer = buffer(array)

        if binary:
            # Convert the vtkUnsignedCharArray into a bytes object, required by
            # Autobahn websockets
            return pBuffer.tobytes() if not compression else zipCompression(pMd5, pBuffer.tobytes())

        return base64Encode(pBuffer if not compression else zipCompression(pMd5, pBuffer.tobytes()))

    def checkForArraysToRelease(self, timeWindow=20):
        cutOffTime = time.time() - timeWindow
        shasToDelete = []
        for sha in self.dataArrayCache:
            record = self.dataArrayCache[sha]
            array = record['array']
            count = array.GetReferenceCount()

            if count == 1 and record['ts'] < cutOffTime:
                shasToDelete.append(sha)

        for sha in shasToDelete:
            del self.dataArrayCache[sha]

    def getLastDependencyList(self, idstr):
        lastDeps = []
        if idstr in self.lastDependenciesMapping and not self.ingoreLastDependencies:
            lastDeps = self.lastDependenciesMapping[idstr]
        return lastDeps

    def setNewDependencyList(self, idstr, depList):
        self.lastDependenciesMapping[idstr] = depList

    def buildDependencyCallList(self, idstr, newList, addMethod, removeMethod):
        oldList = self.getLastDependencyList(idstr)

        calls = []
        calls += [[addMethod, [wrapId(x)]]
                  for x in newList if x not in oldList]
        calls += [[removeMethod, [wrapId(x)]]
                  for x in oldList if x not in newList]

        self.setNewDependencyList(idstr, newList)
        return calls

# -----------------------------------------------------------------------------
# Global variables
# -----------------------------------------------------------------------------

SERIALIZERS = {}
context = None

# -----------------------------------------------------------------------------
# Global API
# -----------------------------------------------------------------------------


def registerInstanceSerializer(name, method):
    global SERIALIZERS
    SERIALIZERS[name] = method

# -----------------------------------------------------------------------------


def serializeInstance(parent, instance, instanceId, context, depth):
    instanceType = instance.GetClassName()
    serializer = SERIALIZERS[
        instanceType] if instanceType in SERIALIZERS else None

    if serializer:
        return serializer(parent, instance, instanceId, context, depth)

    if context.debugSerializers:
        print('%s!!!No serializer for %s with id %s' %
              (pad(depth), instanceType, instanceId))

# -----------------------------------------------------------------------------


def initializeSerializers():
    # Actors/viewProps
    registerInstanceSerializer('vtkImageSlice', genericProp3DSerializer)
    registerInstanceSerializer('vtkVolume', genericProp3DSerializer)
    registerInstanceSerializer('vtkOpenGLActor', genericActorSerializer)
    registerInstanceSerializer('vtkPVLODActor', genericActorSerializer)
    

    # Mappers
    registerInstanceSerializer(
        'vtkOpenGLPolyDataMapper', genericPolyDataMapperSerializer)
    registerInstanceSerializer(
        'vtkCompositePolyDataMapper2', genericPolyDataMapperSerializer)
    registerInstanceSerializer('vtkDataSetMapper', genericPolyDataMapperSerializer)
    registerInstanceSerializer(
        'vtkFixedPointVolumeRayCastMapper', genericVolumeMapperSerializer)
    registerInstanceSerializer(
        'vtkSmartVolumeMapper', genericVolumeMapperSerializer)
    registerInstanceSerializer(
        'vtkOpenGLImageSliceMapper', imageSliceMapperSerializer)

    # LookupTables/TransferFunctions
    registerInstanceSerializer('vtkLookupTable', lookupTableSerializer)
    registerInstanceSerializer(
        'vtkPVDiscretizableColorTransferFunction', colorTransferFunctionSerializer)
    registerInstanceSerializer(
        'vtkColorTransferFunction', colorTransferFunctionSerializer)

    # opacityFunctions
    registerInstanceSerializer(
        'vtkPiecewiseFunction', piecewiseFunctionSerializer)

    # Textures
    registerInstanceSerializer('vtkOpenGLTexture', textureSerializer)

    # Property
    registerInstanceSerializer('vtkOpenGLProperty', propertySerializer)
    registerInstanceSerializer('vtkVolumeProperty', volumePropertySerializer)
    registerInstanceSerializer('vtkImageProperty', imagePropertySerializer)

    # Datasets
    registerInstanceSerializer('vtkPolyData', polydataSerializer)
    registerInstanceSerializer('vtkImageData', imageDataSerializer)
    registerInstanceSerializer(
        'vtkStructuredGrid', mergeToPolydataSerializer)
    registerInstanceSerializer(
        'vtkUnstructuredGrid', mergeToPolydataSerializer)
    registerInstanceSerializer(
        'vtkMultiBlockDataSet', mergeToPolydataSerializer)

    # RenderWindows
    registerInstanceSerializer('vtkCocoaRenderWindow', renderWindowSerializer)
    registerInstanceSerializer(
        'vtkXOpenGLRenderWindow', renderWindowSerializer)
    registerInstanceSerializer(
        'vtkWin32OpenGLRenderWindow', renderWindowSerializer)
    registerInstanceSerializer('vtkEGLRenderWindow', renderWindowSerializer)
    registerInstanceSerializer('vtkOpenVRRenderWindow', renderWindowSerializer)
    registerInstanceSerializer(
        'vtkGenericOpenGLRenderWindow', renderWindowSerializer)
    registerInstanceSerializer(
        'vtkOSOpenGLRenderWindow', renderWindowSerializer)
    registerInstanceSerializer('vtkOpenGLRenderWindow', renderWindowSerializer)
    registerInstanceSerializer('vtkIOSRenderWindow', renderWindowSerializer)
    registerInstanceSerializer(
        'vtkExternalOpenGLRenderWindow', renderWindowSerializer)

    # Renderers
    registerInstanceSerializer('vtkOpenGLRenderer', rendererSerializer)

    # Cameras
    registerInstanceSerializer('vtkOpenGLCamera', cameraSerializer)


# -----------------------------------------------------------------------------
# Helper functions
# -----------------------------------------------------------------------------


def pad(depth):
    padding = ''
    for _ in range(depth):
        padding += '  '
    return padding

# -----------------------------------------------------------------------------


def wrapId(idStr):
    return 'instance:${%s}' % idStr

# -----------------------------------------------------------------------------


def getReferenceId(ref):
    if ref:
        try:
            return ref.__this__[1:17]
        except Exception:
            idStr = str(ref)[-12:-1]
            print('====> fallback ID %s for %s' % (idStr, ref))
            return idStr
    return '0x0'

# -----------------------------------------------------------------------------

dataArrayShaMapping = {}


def digest(array):
    objId = getReferenceId(array)

    record = None
    if objId in dataArrayShaMapping:
        record = dataArrayShaMapping[objId]

    if record and record['mtime'] == array.GetMTime():
        return record['sha']

    record = {
        'sha': hashDataArray(array),
        'mtime': array.GetMTime()
    }

    dataArrayShaMapping[objId] = record
    return record['sha']

# -----------------------------------------------------------------------------


def getRangeInfo(array, component):
    r = array.GetRange(component)
    compRange = {}
    compRange['min'] = r[0]
    compRange['max'] = r[1]
    compRange['component'] = array.GetComponentName(component)
    return compRange

# -----------------------------------------------------------------------------


def getArrayDescription(array, context):
    if not array:
        return None

    pMd5 = digest(array)
    context.cacheDataArray(pMd5, {
        'array': array,
        'mTime': array.GetMTime(),
        'ts': time.time()
    })

    root = {}
    root['hash'] = pMd5
    root['vtkClass'] = 'vtkDataArray'
    root['name'] = array.GetName()
    root['dataType'] = getJSArrayType(array)
    root['numberOfComponents'] = array.GetNumberOfComponents()
    root['size'] = array.GetNumberOfComponents() * array.GetNumberOfTuples()
    root['ranges'] = []
    if root['numberOfComponents'] > 1:
        for i in range(root['numberOfComponents']):
            root['ranges'].append(getRangeInfo(array, i))
        root['ranges'].append(getRangeInfo(array, -1))
    else:
        root['ranges'].append(getRangeInfo(array, 0))

    return root

# -----------------------------------------------------------------------------


def extractRequiredFields(extractedFields, parent, dataset, context, requestedFields=['Normals', 'TCoords']):
    # FIXME should evolve and support funky mapper which leverage many arrays
    if parent.IsA('vtkMapper') or parent.IsA('vtkVolumeMapper'):
        mapper = parent
        scalarVisibility = 1 if mapper.IsA('vtkVolumeMapper') else mapper.GetScalarVisibility()
        arrayAccessMode = mapper.GetArrayAccessMode()
        colorArrayName = mapper.GetArrayName() if arrayAccessMode == 1 else mapper.GetArrayId()
        # colorMode = mapper.GetColorMode()
        scalarMode = mapper.GetScalarMode()
        if scalarVisibility and scalarMode in (1, 3):
            arrayMeta = getArrayDescription(
                dataset.GetPointData().GetArray(colorArrayName), context)
            if arrayMeta:
                arrayMeta['location'] = 'pointData'
                extractedFields.append(arrayMeta)
            elif dataset.GetPointData().GetScalars():
                arrayMeta = getArrayDescription(
                    dataset.GetPointData().GetScalars(), context)
                arrayMeta['location'] = 'pointData'
                arrayMeta['registration'] = 'setScalars'
                extractedFields.append(arrayMeta)
        if scalarVisibility and scalarMode in (2, 4):
            arrayMeta = getArrayDescription(
                dataset.GetCellData().GetArray(colorArrayName), context)
            if arrayMeta:
                arrayMeta['location'] = 'cellData'
                extractedFields.append(arrayMeta)
            elif dataset.GetCellData().GetScalars():
                arrayMeta = getArrayDescription(
                    dataset.GetCellData().GetScalars(), context)
                arrayMeta['location'] = 'cellData'
                arrayMeta['registration'] = 'setScalars'
                extractedFields.append(arrayMeta)

    elif ((parent.IsA('vtkTexture') or parent.IsA('vtkImageSliceMapper'))
          and dataset.GetPointData().GetScalars()):
        arrayMeta = getArrayDescription(
            dataset.GetPointData().GetScalars(), context)
        arrayMeta['location'] = 'pointData'
        arrayMeta['registration'] = 'setScalars'
        extractedFields.append(arrayMeta)

    # Normal handling
    if 'Normals' in requestedFields:
        normals = dataset.GetPointData().GetNormals()
        if normals:
            arrayMeta = getArrayDescription(normals, context)
            if arrayMeta:
                arrayMeta['location'] = 'pointData'
                arrayMeta['registration'] = 'setNormals'
                extractedFields.append(arrayMeta)

    # TCoord handling
    if 'TCoords' in requestedFields:
        tcoords = dataset.GetPointData().GetTCoords()
        if tcoords:
            arrayMeta = getArrayDescription(tcoords, context)
            if arrayMeta:
                arrayMeta['location'] = 'pointData'
                arrayMeta['registration'] = 'setTCoords'
                extractedFields.append(arrayMeta)

# -----------------------------------------------------------------------------
# Concrete instance serializers
# -----------------------------------------------------------------------------

def genericPropSerializer(parent, prop, popId, context, depth):
    # This kind of actor has two "children" of interest, a property and a
    # mapper (optionnaly a texture)
    mapperInstance = None
    propertyInstance = None
    calls = []
    dependencies = []

    mapper = None
    if not hasattr(prop, 'GetMapper'):
        if context.debugAll:
            print('This volume does not have a GetMapper method')
    else:
        mapper = prop.GetMapper()
    
    if mapper:
        mapperId = context.getReferenceId(mapper)
        mapperInstance = serializeInstance(
            prop, mapper, mapperId, context, depth + 1)
        if mapperInstance:
            dependencies.append(mapperInstance)
            calls.append(['setMapper', [wrapId(mapperId)]])

    properties = None
    if hasattr(prop, 'GetProperty'):
        properties = prop.GetProperty()
    else:
        if context.debugAll:
            print('This image does not have a GetProperty method')

    if properties:
        propId = context.getReferenceId(properties)
        propertyInstance = serializeInstance(
            prop, properties, propId, context, depth + 1)
        if propertyInstance:
            dependencies.append(propertyInstance)
            calls.append(['setProperty', [wrapId(propId)]])
    
    # Handle texture if any
    texture = None
    if hasattr(prop, 'GetTexture'):
        texture = prop.GetTexture()

    if texture:
        textureId = context.getReferenceId(texture)
        textureInstance = serializeInstance(
            prop, texture, textureId, context, depth + 1)
        if textureInstance:
            dependencies.append(textureInstance)
            calls.append(['addTexture', [wrapId(textureId)]])

    return {
        'parent': context.getReferenceId(parent),
        'id': popId,
        'type': prop.GetClassName(),
        'properties': {
            # vtkProp
            'visibility': prop.GetVisibility(),
            'pickable': prop.GetPickable(),
            'dragable': prop.GetDragable(),
            'useBounds': prop.GetUseBounds(),  
        },
        'calls': calls,
        'dependencies': dependencies
    }

# -----------------------------------------------------------------------------


def genericProp3DSerializer(parent, prop3D, prop3DId, context, depth):
    # This kind of actor has some position properties to add
    instance = genericPropSerializer(parent, prop3D, prop3DId, context, depth)
    
    if not instance: return
    
    instance['properties'].update({
        # vtkProp3D
        'origin': prop3D.GetOrigin(),
        'position': prop3D.GetPosition(),
        'scale': prop3D.GetScale(),
        'orientation': prop3D.GetOrientation(),
    })
    
    if prop3D.GetUserMatrix():
        instance['properties'].update({
            'userMatrix': [prop3D.GetUserMatrix().GetElement(i%4,i//4) for i in range(16)],
        })
    return instance

# -----------------------------------------------------------------------------


def genericActorSerializer(parent, actor, actorId, context, depth):
    # may have texture and 
    instance = genericProp3DSerializer(parent, actor, actorId, context, depth)

    if not instance: return

    instance['properties'].update({
        # vtkActor
        'forceOpaque': actor.GetForceOpaque(),
        'forceTranslucent': actor.GetForceTranslucent()
    })
    return instance

# -----------------------------------------------------------------------------


def genericMapperSerializer(parent, mapper, mapperId, context, depth):
    # This kind of mapper requires us to get 2 items: input data and lookup
    # table
    dataObject = None
    dataObjectInstance = None
    lookupTableInstance = None
    calls = []
    dependencies = []

    if hasattr(mapper, 'GetInputDataObject'):
        dataObject = mapper.GetInputDataObject(0, 0)
    else:
        if context.debugAll:
            print('This mapper does not have GetInputDataObject method')

    if dataObject:
        dataObjectId = '%s-dataset' % mapperId
        if parent.IsA('vtkActor') and not mapper.IsA('vtkTexture'):
            # vtk-js actors can render only surfacic datasets
            # => we ensure to convert the dataset in polydata
            dataObjectInstance = mergeToPolydataSerializer(
                mapper, dataObject, dataObjectId, context, depth + 1)
        else:
            dataObjectInstance = serializeInstance(
                mapper, dataObject, dataObjectId, context, depth + 1)
        if dataObjectInstance:
            dependencies.append(dataObjectInstance)
            calls.append(['setInputData', [wrapId(dataObjectId)]])

    lookupTable = None

    if hasattr(mapper, 'GetLookupTable'):
        lookupTable = mapper.GetLookupTable()
    elif parent.IsA('vtkActor'):
        if context.debugAll:
            print('This mapper actor not have GetLookupTable method')

    if lookupTable:
        lookupTableId = context.getReferenceId(lookupTable)
        lookupTableInstance = serializeInstance(
            mapper, lookupTable, lookupTableId, context, depth + 1)
        if lookupTableInstance:
            dependencies.append(lookupTableInstance)
            calls.append(['setLookupTable', [wrapId(lookupTableId)]])

    if dataObjectInstance:
        return {
            'parent': context.getReferenceId(parent),
            'id': mapperId,
            'properties': {},
            'calls': calls,
            'dependencies': dependencies
        }

# -----------------------------------------------------------------------------


def genericPolyDataMapperSerializer(parent, mapper, mapperId, context, depth):
    instance = genericMapperSerializer(parent, mapper, mapperId, context, depth)

    if not instance: return

    colorArrayName = mapper.GetArrayName(
        ) if mapper.GetArrayAccessMode() == 1 else mapper.GetArrayId()

    instance['type'] = mapper.GetClassName()
    instance['properties'].update({
        'resolveCoincidentTopology': mapper.GetResolveCoincidentTopology(),
        'renderTime': mapper.GetRenderTime(),
        'arrayAccessMode': mapper.GetArrayAccessMode(),
        'scalarRange': mapper.GetScalarRange(),
        'useLookupTableScalarRange': 1 if mapper.GetUseLookupTableScalarRange() else 0,
        'scalarVisibility': mapper.GetScalarVisibility(),
        'colorByArrayName': colorArrayName,
        'colorMode': mapper.GetColorMode(),
        'scalarMode': mapper.GetScalarMode(),
        'interpolateScalarsBeforeMapping': 1 if mapper.GetInterpolateScalarsBeforeMapping() else 0
    })
    return instance

# -----------------------------------------------------------------------------


def genericVolumeMapperSerializer(parent, mapper, mapperId, context, depth):
    instance = genericMapperSerializer(parent, mapper, mapperId, context, depth)

    if not instance: return

    imageSampleDistance = (
        mapper.GetImageSampleDistance() 
        if hasattr(mapper, 'GetImageSampleDistance') 
        else 1
    )
    instance['type'] = mapper.GetClassName()
    instance['properties'].update({
        'sampleDistance': mapper.GetSampleDistance(),
        'imageSampleDistance': imageSampleDistance,
        # 'maximumSamplesPerRay',
        'autoAdjustSampleDistances': mapper.GetAutoAdjustSampleDistances(),
        'blendMode': mapper.GetBlendMode(),
    })
    return instance

# -----------------------------------------------------------------------------


def textureSerializer(parent, texture, textureId, context, depth):
    instance = genericMapperSerializer(parent, texture, textureId, context, depth)

    if not instance: return

    instance['type'] = texture.GetClassName()
    instance['properties'].update({
        'interpolate': texture.GetInterpolate(),
        'repeat': texture.GetRepeat(),
        'edgeClamp': texture.GetEdgeClamp(),
    })
    return instance

# -----------------------------------------------------------------------------


def imageSliceMapperSerializer(parent, mapper, mapperId, context, depth):
    # On vtkjs side : vtkImageMapper connected to a vtkImageReslice filter

    instance = genericMapperSerializer(parent, mapper, mapperId, context, depth)    

    if not instance: return

    instance['type'] = mapper.GetClassName()
    
    return instance

# -----------------------------------------------------------------------------


def lookupTableSerializer(parent, lookupTable, lookupTableId, context, depth):
    # No children in this case, so no additions to bindings and return empty list
    # But we do need to add instance
    arrays = []
    lookupTableRange = lookupTable.GetRange()

    lookupTableHueRange = [0.5, 0]
    if hasattr(lookupTable, 'GetHueRange'):
        try:
            lookupTable.GetHueRange(lookupTableHueRange)
        except Exception:
            pass

    lutSatRange = lookupTable.GetSaturationRange()
    # lutAlphaRange = lookupTable.GetAlphaRange()
    if lookupTable.GetTable():
        arrayMeta = getArrayDescription(lookupTable.GetTable(), context)
        if arrayMeta:
            arrayMeta['registration'] = 'setTable'
            arrays.append(arrayMeta)

    return {
        'parent': context.getReferenceId(parent),
        'id': lookupTableId,
        'type': lookupTable.GetClassName(),
        'properties': {
            'numberOfColors': lookupTable.GetNumberOfColors(),
            'valueRange': lookupTableRange,
            'hueRange': lookupTableHueRange,
            # 'alphaRange': lutAlphaRange,  # Causes weird rendering artifacts on client
            'saturationRange': lutSatRange,
            'nanColor': lookupTable.GetNanColor(),
            'belowRangeColor': lookupTable.GetBelowRangeColor(),
            'aboveRangeColor': lookupTable.GetAboveRangeColor(),
            'useAboveRangeColor': True if lookupTable.GetUseAboveRangeColor() else False,
            'useBelowRangeColor': True if lookupTable.GetUseBelowRangeColor() else False,
            'alpha': lookupTable.GetAlpha(),
            'vectorSize': lookupTable.GetVectorSize(),
            'vectorComponent': lookupTable.GetVectorComponent(),
            'vectorMode': lookupTable.GetVectorMode(),
            'indexedLookup': lookupTable.GetIndexedLookup(),
        }, 
        'arrays': arrays,
    }

# -----------------------------------------------------------------------------


def lookupTableToColorTransferFunction(lookupTable):
    dataTable = lookupTable.GetTable()
    table = dataTableToList(dataTable)
    if table:
        ctf = vtkColorTransferFunction()
        tableRange = lookupTable.GetTableRange()
        points = linspace(*tableRange, num=len(table))
        for x, rgba in zip(points, table):
            ctf.AddRGBPoint(x, *[x/255 for x in rgba[:3]])
        return ctf

# -----------------------------------------------------------------------------


def lookupTableSerializer2(parent, lookupTable, lookupTableId, context, depth):
    ctf = lookupTableToColorTransferFunction(lookupTable)
    if ctf:
        return colorTransferFunctionSerializer(parent, ctf, lookupTableId, context, depth)

# -----------------------------------------------------------------------------


def propertySerializer(parent, propObj, propObjId, context, depth):
    representation = propObj.GetRepresentation() if hasattr(
        propObj, 'GetRepresentation') else 2
    colorToUse = propObj.GetDiffuseColor() if hasattr(
        propObj, 'GetDiffuseColor') else [1, 1, 1]
    if representation == 1 and hasattr(propObj, 'GetColor'):
        colorToUse = propObj.GetColor()

    return {
        'parent': context.getReferenceId(parent),
        'id': propObjId,
        'type': propObj.GetClassName(),
        'properties': {
            'representation': representation,
            'diffuseColor': colorToUse,
            'color': propObj.GetColor(),
            'ambientColor': propObj.GetAmbientColor(),
            'specularColor': propObj.GetSpecularColor(),
            'edgeColor': propObj.GetEdgeColor(),
            'ambient': propObj.GetAmbient(),
            'diffuse': propObj.GetDiffuse(),
            'specular': propObj.GetSpecular(),
            'specularPower': propObj.GetSpecularPower(),
            'opacity': propObj.GetOpacity(),
            'interpolation': propObj.GetInterpolation(),
            'edgeVisibility': 1 if propObj.GetEdgeVisibility() else 0,
            'backfaceCulling': 1 if propObj.GetBackfaceCulling() else 0,
            'frontfaceCulling': 1 if propObj.GetFrontfaceCulling() else 0,
            'pointSize': propObj.GetPointSize(),
            'lineWidth': propObj.GetLineWidth(),
            'lighting': 1 if propObj.GetLighting() else 0,
        }
    }

# -----------------------------------------------------------------------------

def volumePropertySerializer(parent, propObj, propObjId, context, depth):
    dependencies = []
    calls = []
    # TODO: for the moment only component 0 handle

    #OpactiyFunction
    ofun = propObj.GetScalarOpacity()
    if ofun:
        ofunId = context.getReferenceId(ofun)
        ofunInstance = serializeInstance(
            propObj, ofun, ofunId, context, depth + 1)
        if ofunInstance:
            dependencies.append(ofunInstance)
            calls.append(['setScalarOpacity', [0, wrapId(ofunId)]])

    # ColorTranferFunction
    ctfun = propObj.GetRGBTransferFunction()
    if ctfun:
        ctfunId = context.getReferenceId(ctfun)
        ctfunInstance = serializeInstance(
            propObj, ctfun, ctfunId, context, depth + 1)
        if ctfunInstance:
            dependencies.append(ctfunInstance)
            calls.append(['setRGBTransferFunction', [0, wrapId(ctfunId)]])

    calls += [
        ['setScalarOpacityUnitDistance', [0, propObj.GetScalarOpacityUnitDistance(0)]],
        ['setComponentWeight', [0, propObj.GetComponentWeight(0)]],
        ['setUseGradientOpacity', [0, int(not propObj.GetDisableGradientOpacity())]],
    ]

    return {
        'parent': context.getReferenceId(parent),
        'id': propObjId,
        'type': propObj.GetClassName(),
        'properties': {
            'independentComponents': propObj.GetIndependentComponents(),
            'interpolationType': propObj.GetInterpolationType(),
            'ambient': propObj.GetAmbient(),
            'diffuse': propObj.GetDiffuse(),
            'shade': propObj.GetShade(),
            'specular': propObj.GetSpecular(0),
            'specularPower': propObj.GetSpecularPower(),
        },
        'dependencies': dependencies,
        'calls': calls,
    }

# -----------------------------------------------------------------------------


def imagePropertySerializer(parent, propObj, propObjId, context, depth):
    calls = []
    dependencies = []

    lookupTable = propObj.GetLookupTable()
    if lookupTable: 
        ctfun = lookupTableToColorTransferFunction(lookupTable)
        ctfunId = context.getReferenceId(ctfun)
        ctfunInstance = serializeInstance(
            propObj, ctfun, ctfunId, context, depth + 1)
        if ctfunInstance:
            dependencies.append(ctfunInstance)
            calls.append(['setRGBTransferFunction', [wrapId(ctfunId)]])

    return {
        'parent': context.getReferenceId(parent),
        'id': propObjId,
        'type': propObj.GetClassName(),
        'properties': {
            'interpolationType': propObj.GetInterpolationType(),
            'colorWindow': propObj.GetColorWindow(),
            'colorLevel': propObj.GetColorLevel(),
            'ambient': propObj.GetAmbient(),
            'diffuse': propObj.GetDiffuse(),
            'opacity': propObj.GetOpacity(),
        },
        'dependencies': dependencies,
        'calls': calls,
    }

# -----------------------------------------------------------------------------


def imageDataSerializer(parent, dataset, datasetId, context, depth):
    datasetType = dataset.GetClassName()

    if hasattr(dataset, 'GetDirectionMatrix'):
        direction = [dataset.GetDirectionMatrix().GetElement(0, i)
                     for i in range(9)]
    else:
        direction = [1, 0, 0,
                     0, 1, 0,
                     0, 0, 1]

    # Extract dataset fields
    arrays = []
    extractRequiredFields(arrays, parent, dataset, context)

    return {
        'parent': context.getReferenceId(parent),
        'id': datasetId,
        'type': datasetType,
        'properties': {
            'spacing': dataset.GetSpacing(),
            'origin': dataset.GetOrigin(),
            'dimensions': dataset.GetDimensions(),
            'direction': direction,
        },
        'arrays': arrays
    }

# -----------------------------------------------------------------------------


def polydataSerializer(parent, dataset, datasetId, context, depth):
    datasetType = dataset.GetClassName()

    if dataset and dataset.GetPoints():
        properties = {}

        # Points
        points = getArrayDescription(dataset.GetPoints().GetData(), context)
        points['vtkClass'] = 'vtkPoints'
        properties['points'] = points

        # Verts
        if dataset.GetVerts() and dataset.GetVerts().GetData().GetNumberOfTuples() > 0:
            _verts = getArrayDescription(dataset.GetVerts().GetData(), context)
            properties['verts'] = _verts
            properties['verts']['vtkClass'] = 'vtkCellArray'

        # Lines
        if dataset.GetLines() and dataset.GetLines().GetData().GetNumberOfTuples() > 0:
            _lines = getArrayDescription(dataset.GetLines().GetData(), context)
            properties['lines'] = _lines
            properties['lines']['vtkClass'] = 'vtkCellArray'

        # Polys
        if dataset.GetPolys() and dataset.GetPolys().GetData().GetNumberOfTuples() > 0:
            _polys = getArrayDescription(dataset.GetPolys().GetData(), context)
            properties['polys'] = _polys
            properties['polys']['vtkClass'] = 'vtkCellArray'

        # Strips
        if dataset.GetStrips() and dataset.GetStrips().GetData().GetNumberOfTuples() > 0:
            _strips = getArrayDescription(
                dataset.GetStrips().GetData(), context)
            properties['strips'] = _strips
            properties['strips']['vtkClass'] = 'vtkCellArray'

        # Fields
        properties['fields'] = []
        extractRequiredFields(properties['fields'], parent, dataset, context)

        return {
            'parent': context.getReferenceId(parent),
            'id': datasetId,
            'type': datasetType,
            'properties': properties
        }

    if context.debugAll:
        print('This dataset has no points!')

# -----------------------------------------------------------------------------


def mergeToPolydataSerializer(parent, dataObject, dataObjectId, context, depth):
    dataset = None

    if dataObject.IsA('vtkCompositeDataSet'):
        gf = vtkCompositeDataGeometryFilter()
        gf.SetInputData(dataObject)
        gf.Update()
        dataset = gf.GetOutput()
    elif (dataObject.IsA('vtkUnstructuredGrid') or
          dataObject.IsA('vtkStructuredGrid') or
          dataObject.IsA('vtkImageData')):
        gf = vtkGeometryFilter()
        gf.SetInputData(dataObject)
        gf.Update()
        dataset = gf.GetOutput()
    else:
        dataset = parent.GetInput()

    return polydataSerializer(parent, dataset, dataObjectId, context, depth)

# -----------------------------------------------------------------------------


def colorTransferFunctionSerializer(parent, instance, objId, context, depth):
    nodes = []

    for i in range(instance.GetSize()):
        # x, r, g, b, midpoint, sharpness
        node = [0, 0, 0, 0, 0, 0]
        instance.GetNodeValue(i, node)
        nodes.append(node)

    return {
        'parent': context.getReferenceId(parent),
        'id': objId,
        'type': instance.GetClassName(),
        'properties': {
            'clamping': 1 if instance.GetClamping() else 0,
            'colorSpace': instance.GetColorSpace(),
            'hSVWrap': 1 if instance.GetHSVWrap() else 0,
            # 'nanColor': instance.GetNanColor(),                  # Breaks client
            # 'belowRangeColor': instance.GetBelowRangeColor(),    # Breaks client
            # 'aboveRangeColor': instance.GetAboveRangeColor(),    # Breaks client
            # 'useAboveRangeColor': 1 if instance.GetUseAboveRangeColor() else 0,
            # 'useBelowRangeColor': 1 if instance.GetUseBelowRangeColor() else 0,
            'allowDuplicateScalars': 1 if instance.GetAllowDuplicateScalars() else 0,
            'alpha': instance.GetAlpha(),
            'vectorComponent': instance.GetVectorComponent(),
            'vectorSize': instance.GetVectorSize(),
            'vectorMode': instance.GetVectorMode(),
            'indexedLookup': instance.GetIndexedLookup(),
            'nodes': nodes
        }
    }

# -----------------------------------------------------------------------------


def piecewiseFunctionSerializer(parent, instance, objId, context, depth):
    nodes = []

    for i in range(instance.GetSize()):
        # x, y, midpoint, sharpness
        node = [0, 0, 0, 0]
        instance.GetNodeValue(i, node)
        nodes.append(node)

    return {
        'parent': context.getReferenceId(parent),
        'id': objId,
        'type': instance.GetClassName(),
        'properties': {
            'clamping': instance.GetClamping(),
            'allowDuplicateScalars': instance.GetAllowDuplicateScalars(),
            'nodes': nodes,
        }
    }
# -----------------------------------------------------------------------------


def rendererSerializer(parent, instance, objId, context, depth):
    dependencies = []
    viewPropIds = []
    calls = []

    # Camera
    camera = instance.GetActiveCamera()
    cameraId = context.getReferenceId(camera)
    cameraInstance = serializeInstance(
        instance, camera, cameraId, context, depth + 1)
    if cameraInstance:
        dependencies.append(cameraInstance)
        calls.append(['setActiveCamera', [wrapId(cameraId)]])

    # View prop as representation containers
    viewPropCollection = instance.GetViewProps()
    for rpIdx in range(viewPropCollection.GetNumberOfItems()):
        viewProp = viewPropCollection.GetItemAsObject(rpIdx)
        viewPropId = context.getReferenceId(viewProp)

        viewPropInstance = serializeInstance(
            instance, viewProp, viewPropId, context, depth + 1)
        if viewPropInstance:
            dependencies.append(viewPropInstance)
            viewPropIds.append(viewPropId)

    calls += context.buildDependencyCallList('%s-props' %
                                             objId, viewPropIds, 'addViewProp', 'removeViewProp')

    return {
        'parent': context.getReferenceId(parent),
        'id': objId,
        'type': instance.GetClassName(),
        'properties': {
            'background': instance.GetBackground(),
            'background2': instance.GetBackground2(),
            'viewport': instance.GetViewport(),
            # These commented properties do not yet have real setters in vtk.js
            # 'gradientBackground': instance.GetGradientBackground(),
            # 'aspect': instance.GetAspect(),
            # 'pixelAspect': instance.GetPixelAspect(),
            # 'ambient': instance.GetAmbient(),
            'twoSidedLighting': instance.GetTwoSidedLighting(),
            'lightFollowCamera': instance.GetLightFollowCamera(),
            'layer': instance.GetLayer(),
            'preserveColorBuffer': instance.GetPreserveColorBuffer(),
            'preserveDepthBuffer': instance.GetPreserveDepthBuffer(),
            'nearClippingPlaneTolerance': instance.GetNearClippingPlaneTolerance(),
            'clippingRangeExpansion': instance.GetClippingRangeExpansion(),
            'useShadows': instance.GetUseShadows(),
            'useDepthPeeling': instance.GetUseDepthPeeling(),
            'occlusionRatio': instance.GetOcclusionRatio(),
            'maximumNumberOfPeels': instance.GetMaximumNumberOfPeels()
        },
        'dependencies': dependencies,
        'calls': calls
    }

# -----------------------------------------------------------------------------


def cameraSerializer(parent, instance, objId, context, depth):
    return {
        'parent': context.getReferenceId(parent),
        'id': objId,
        'type': instance.GetClassName(),
        'properties': {
            'focalPoint': instance.GetFocalPoint(),
            'position': instance.GetPosition(),
            'viewUp': instance.GetViewUp(),
            'clippingRange': instance.GetClippingRange(),
        }
    }

# -----------------------------------------------------------------------------


def renderWindowSerializer(parent, instance, objId, context, depth):
    dependencies = []
    rendererIds = []

    rendererCollection = instance.GetRenderers()
    for rIdx in range(rendererCollection.GetNumberOfItems()):
        # Grab the next vtkRenderer
        renderer = rendererCollection.GetItemAsObject(rIdx)
        rendererId = context.getReferenceId(renderer)
        rendererInstance = serializeInstance(
            instance, renderer, rendererId, context, depth + 1)
        if rendererInstance:
            dependencies.append(rendererInstance)
            rendererIds.append(rendererId)

    calls = context.buildDependencyCallList(
        objId, rendererIds, 'addRenderer', 'removeRenderer')

    return {
        'parent': context.getReferenceId(parent),
        'id': objId,
        'type': instance.GetClassName(),
        'properties': {
            'numberOfLayers': instance.GetNumberOfLayers()
        },
        'dependencies': dependencies,
        'calls': calls,
        'mtime': instance.GetMTime(),
    }
